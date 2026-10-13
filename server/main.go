// world360-api: takes the current World360 frame as a PNG, runs it through Krea2 img2img on a
// ComfyUI instance in a comic style, and serves the result. ComfyUI itself stays private;
// only this service is exposed, behind a reverse proxy at /api/*.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

var (
	listen   = flag.String("listen", "127.0.0.1:18096", "listen address")
	comfyURL = flag.String("comfy", "http://127.0.0.1:8188", "ComfyUI base URL")
	maxQueue = flag.Int("max-queue", 14, "max jobs waiting or running")
	perDay    = flag.Int("per-day", 2, "generations per client IP per 24h")
	unlimited = flag.String("unlimited", "", "comma-separated IPs without the daily limit (private ranges always unlimited)")
	unetName  = flag.String("unet", "krea2_turbo_fp8_scaled.safetensors", "Krea2 diffusion model (ComfyUI models/diffusion_models)")
	clipName  = flag.String("clip", "qwen3vl_4b_fp8_scaled.safetensors", "Qwen3-VL-4B text encoder (ComfyUI models/text_encoders)")
	vaeName   = flag.String("vae", "qwen_image_vae.safetensors", "VAE (ComfyUI models/vae)")
	quotaFile = flag.String("quota-file", "quota.json", "where per-IP usage survives restarts")
)

type style struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Prompt  string `json:"-"`
	Enabled bool   `json:"enabled"`
	NameEn  string `json:"name_en"`
}

// Krea2 reads natural prose (Qwen3-VL encoder), so styles are sentences, not tag lists.
var styles = []style{
	{"manga", "Манґа (ч/б)", "Black and white Japanese manga background art: crisp black ink linework, ruler-straight architecture, detailed windows and roofs, screentone dot shading in shadows, solid black fills, pure white sky.", true, "Manga (B&W)"},
	{"ligne", "Лінь клер", "European ligne claire comic illustration: clean uniform black outlines, flat bright colors, red tiled roofs, no hatching, clear sunny daylight.", false, "Ligne claire"},
	{"american", "Американський комікс", "American comic book art: bold black inks, heavy spotted blacks, dramatic shadows, saturated flat colors with halftone texture, dynamic and punchy.", false, "American comic"},
	{"noir", "Нуар", "Noir graphic novel at night: high contrast black and white, deep solid black shadows, hard light from street lamps and windows, wet reflective streets, gritty brush ink.", false, "Noir"},
	{"watercolor", "Аніме-акварель", "Hand-painted anime film background: soft watercolor and gouache, warm afternoon light, lush trees, carefully painted roofs and windows, fluffy clouds in a blue sky.", false, "Anime watercolor"},
	{"webtoon", "Вебтун", "Korean webtoon digital comic art: clean digital lineart, soft cel shading with gentle gradients, pastel colors, bright soft daylight.", true, "Webtoon"},
	{"sketch", "Олівцевий скетч", "Pencil and ink storyboard sketch: loose confident pencil lines, light graphite shading, cross-hatching in shadows, off-white paper.", false, "Pencil sketch"},
}

type job struct {
	ID       string    `json:"id"`
	Style    string    `json:"style"`
	Status   string    `json:"status"` // queued | running | done | error
	Error    string    `json:"error,omitempty"`
	Images   []string  `json:"images,omitempty"`
	Created  time.Time `json:"created"`
	promptID string
	files    []comfyFile
}

type comfyFile struct{ Filename, Subfolder, Type string }

type server struct {
	mu   sync.Mutex
	jobs map[string]*job
	hits map[string][]time.Time
	work chan *job
	hc   *http.Client
}

func main() {
	flag.Parse()
	s := &server{jobs: map[string]*job{}, hits: map[string][]time.Time{}, work: make(chan *job, 64), hc: &http.Client{Timeout: 60 * time.Second}}
	s.loadQuota()
	go s.worker()
	go s.janitor()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/styles", s.handleStyles)
	mux.HandleFunc("GET /api/quota", s.handleQuota)
	mux.HandleFunc("POST /api/generate", s.handleGenerate)
	mux.HandleFunc("GET /api/job/{id}", s.handleJob)
	mux.HandleFunc("GET /api/image/{id}/{n}", s.handleImage)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		resp, err := s.hc.Get(*comfyURL + "/system_stats")
		if err != nil {
			http.Error(w, "comfy down: "+err.Error(), http.StatusBadGateway)
			return
		}
		resp.Body.Close()
		fmt.Fprintln(w, "ok")
	})
	slog.Info("listening", "addr", *listen, "comfy", *comfyURL)
	srv := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("server", "err", err)
		os.Exit(1)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func clientIP(r *http.Request) string {
	// Caddy (realip) sets X-Forwarded-For; we only listen on loopback, so it is trusted.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

func (s *server) handleStyles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, styles)
}

type genReq struct {
	Image   string  `json:"image"` // data:image/png;base64,...
	Style   string  `json:"style"`
	Denoise float64 `json:"denoise"`
	Extra   string  `json:"extra"`
	View    string  `json:"view"` // camera description written by the client
	Seed    int64   `json:"seed"`
}

func (s *server) handleGenerate(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 12<<20)
	var req genReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json: " + err.Error()})
		return
	}
	var st *style
	for i := range styles {
		if styles[i].ID == req.Style {
			st = &styles[i]
		}
	}
	if st == nil || !st.Enabled {
		writeJSON(w, 400, map[string]any{"error": "style unavailable", "code": "style"})
		return
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(req.Image, "data:image/png;base64,"))
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "image must be a base64 PNG"})
		return
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width < 256 || cfg.Height < 256 || cfg.Width*cfg.Height > 2_100_000 {
		writeJSON(w, 400, map[string]string{"error": "PNG must be 256px..~2MP"})
		return
	}
	if req.Denoise < 0.3 || req.Denoise > 0.9 {
		req.Denoise = 0.55
	}
	req.Extra = clip(req.Extra, 300)
	req.View = clip(req.View, 400)

	ip := clientIP(r)
	s.mu.Lock()
	now := time.Now()
	recent := s.hits[ip][:0]
	for _, t := range s.hits[ip] {
		if now.Sub(t) < 24*time.Hour {
			recent = append(recent, t)
		}
	}
	s.hits[ip] = recent
	active := 0
	for _, j := range s.jobs {
		if j.Status == "queued" || j.Status == "running" {
			active++
		}
	}
	if !isUnlimited(ip) && len(recent) >= *perDay {
		s.mu.Unlock()
		writeJSON(w, 429, map[string]any{"error": fmt.Sprintf("daily limit of %d images reached", *perDay), "code": "quota", "limit": *perDay})
		return
	}
	if active >= *maxQueue {
		s.mu.Unlock()
		writeJSON(w, 503, map[string]any{"error": "queue is full", "code": "queue"})
		return
	}
	s.hits[ip] = append(s.hits[ip], now)
	s.saveQuota()
	j := &job{ID: randID(), Style: st.ID, Status: "queued", Created: now}
	s.jobs[j.ID] = j
	s.mu.Unlock()

	// the view sentence keeps the composition; without it Krea2 drifts to a frontal facade
	view := req.View
	if view == "" {
		view = "A city scene with the same layout and perspective as the reference."
	}
	prompt := view + " " + st.Prompt
	if req.Extra != "" {
		prompt += " " + req.Extra
	}
	seed := req.Seed
	if seed <= 0 {
		seed = time.Now().UnixNano() % 1_000_000_000
	}
	go func() {
		if err := s.submit(j, raw, prompt, req.Denoise, seed); err != nil {
			s.fail(j, err)
			return
		}
		s.work <- j
	}()
	writeJSON(w, 202, j)
}

func (s *server) fail(j *job, err error) {
	slog.Warn("job failed", "id", j.ID, "err", err)
	s.mu.Lock()
	j.Status, j.Error = "error", err.Error()
	s.mu.Unlock()
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func randID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// upload the frame and queue the Krea2 img2img graph
func (s *server) submit(j *job, img []byte, prompt string, denoise float64, seed int64) error {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("image", "world360_"+j.ID+".png")
	fw.Write(img)
	mw.WriteField("overwrite", "true")
	mw.Close()
	resp, err := s.hc.Post(*comfyURL+"/upload/image", mw.FormDataContentType(), &buf)
	if err != nil {
		return fmt.Errorf("upload: %w", err)
	}
	var up struct{ Name, Subfolder string }
	err = json.NewDecoder(resp.Body).Decode(&up)
	resp.Body.Close()
	if err != nil || up.Name == "" {
		return fmt.Errorf("upload: bad response (%d)", resp.StatusCode)
	}

	// turbo model: effective steps = steps*denoise, keep ~8
	steps := int(8/denoise + 0.5)
	graph := map[string]any{
		"1": node("UNETLoader", map[string]any{"unet_name": *unetName, "weight_dtype": "default"}),
		"2": node("CLIPLoader", map[string]any{"clip_name": *clipName, "type": "krea2", "device": "default"}),
		"3": node("VAELoader", map[string]any{"vae_name": *vaeName}),
		"4": node("CLIPTextEncode", map[string]any{"text": prompt, "clip": []any{"2", 0}}),
		"5": node("ConditioningZeroOut", map[string]any{"conditioning": []any{"4", 0}}),
		"6": node("LoadImage", map[string]any{"image": up.Name}),
		"7": node("VAEEncode", map[string]any{"pixels": []any{"6", 0}, "vae": []any{"3", 0}}),
		"8": node("KSampler", map[string]any{"seed": seed, "steps": steps, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
			"denoise": denoise, "model": []any{"1", 0}, "positive": []any{"4", 0}, "negative": []any{"5", 0}, "latent_image": []any{"7", 0}}),
		"9":  node("VAEDecode", map[string]any{"samples": []any{"8", 0}, "vae": []any{"3", 0}}),
		"10": node("SaveImage", map[string]any{"filename_prefix": "world360/" + j.Style, "images": []any{"9", 0}}),
	}
	body, _ := json.Marshal(map[string]any{"prompt": graph, "client_id": "world360"})
	resp, err = s.hc.Post(*comfyURL+"/prompt", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("queue: %w", err)
	}
	defer resp.Body.Close()
	var q struct {
		PromptID string          `json:"prompt_id"`
		Error    json.RawMessage `json:"error"`
	}
	b, _ := io.ReadAll(resp.Body)
	if json.Unmarshal(b, &q); q.PromptID == "" {
		return fmt.Errorf("queue: %d %s", resp.StatusCode, truncate(string(b), 300))
	}
	s.mu.Lock()
	j.promptID = q.PromptID
	s.mu.Unlock()
	return nil
}

func node(class string, inputs map[string]any) map[string]any {
	return map[string]any{"class_type": class, "inputs": inputs}
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// poll ComfyUI history for each submitted job
func (s *server) worker() {
	for j := range s.work {
		go s.watch(j)
	}
}

func (s *server) watch(j *job) {
	deadline := time.Now().Add(15 * time.Minute)
	for time.Now().Before(deadline) {
		time.Sleep(1500 * time.Millisecond)
		files, state, err := s.history(j.promptID)
		if err != nil {
			continue
		}
		s.mu.Lock()
		switch state {
		case "running":
			j.Status = "running"
		case "error":
			j.Status, j.Error = "error", "ComfyUI execution error"
		case "done":
			j.files = files
			j.Images = nil
			for i := range files {
				j.Images = append(j.Images, fmt.Sprintf("/api/image/%s/%d", j.ID, i))
			}
			j.Status = "done"
		}
		st := j.Status
		s.mu.Unlock()
		if st == "done" || st == "error" {
			return
		}
	}
	s.fail(j, errors.New("timeout"))
}

func (s *server) history(promptID string) ([]comfyFile, string, error) {
	resp, err := s.hc.Get(*comfyURL + "/history/" + promptID)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	var h map[string]struct {
		Status struct {
			StatusStr string `json:"status_str"`
			Completed bool   `json:"completed"`
		} `json:"status"`
		Outputs map[string]struct {
			Images []struct {
				Filename  string `json:"filename"`
				Subfolder string `json:"subfolder"`
				Type      string `json:"type"`
			} `json:"images"`
		} `json:"outputs"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		return nil, "", err
	}
	e, ok := h[promptID]
	if !ok {
		return nil, "running", nil // still queued or running
	}
	if e.Status.StatusStr == "error" {
		return nil, "error", nil
	}
	if !e.Status.Completed {
		return nil, "running", nil
	}
	var out []comfyFile
	for _, o := range e.Outputs {
		for _, im := range o.Images {
			out = append(out, comfyFile{im.Filename, im.Subfolder, im.Type})
		}
	}
	return out, "done", nil
}

func (s *server) handleJob(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j, ok := s.jobs[r.PathValue("id")]
	var cp job
	if ok {
		cp = *j
	}
	s.mu.Unlock()
	if !ok {
		writeJSON(w, 404, map[string]string{"error": "no such job"})
		return
	}
	writeJSON(w, 200, cp)
}

func (s *server) handleImage(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j, ok := s.jobs[r.PathValue("id")]
	var f comfyFile
	n := r.PathValue("n")
	if ok {
		var i int
		fmt.Sscan(n, &i)
		if i >= 0 && i < len(j.files) {
			f = j.files[i]
		} else {
			ok = false
		}
	}
	s.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	q := "filename=" + urlq(f.Filename) + "&subfolder=" + urlq(f.Subfolder) + "&type=" + urlq(f.Type)
	resp, err := s.hc.Get(*comfyURL + "/view?" + q)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "private, max-age=86400")
	io.Copy(w, resp.Body)
}

func urlq(s string) string { return url.QueryEscape(s) }

// forget jobs after a day
func (s *server) janitor() {
	for range time.Tick(10 * time.Minute) {
		s.mu.Lock()
		for id, j := range s.jobs {
			if time.Since(j.Created) > 24*time.Hour {
				delete(s.jobs, id)
			}
		}
		s.mu.Unlock()
	}
}

func isUnlimited(ip string) bool {
	if a := net.ParseIP(ip); a != nil && (a.IsPrivate() || a.IsLoopback()) {
		return true
	}
	for _, u := range strings.Split(*unlimited, ",") {
		if strings.TrimSpace(u) == ip {
			return true
		}
	}
	return false
}

func (s *server) handleQuota(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	s.mu.Lock()
	used := 0
	for _, t := range s.hits[ip] {
		if time.Since(t) < 24*time.Hour {
			used++
		}
	}
	s.mu.Unlock()
	writeJSON(w, 200, map[string]any{"limit": *perDay, "used": used, "unlimited": isUnlimited(ip)})
}

// caller holds s.mu
func (s *server) saveQuota() {
	b, _ := json.Marshal(s.hits)
	tmp := *quotaFile + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err == nil {
		os.Rename(tmp, *quotaFile)
	}
}

func (s *server) loadQuota() {
	b, err := os.ReadFile(*quotaFile)
	if err == nil {
		json.Unmarshal(b, &s.hits)
	}
}
