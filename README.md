# OpenRouter Media MCP — LibreChat üçün Şəkil / Video / Səs alətləri

LibreChat-ın koduna toxunmadan, OpenRouter-in şəkil, video və TTS (mətndən səs) modellərini
LibreChat agentlərinə alət kimi verən MCP server.

## Nəyə əsaslanır (təxmin yox, yoxlanılıb)

**OpenRouter (rəsmi sənədlər + canlı API, 26.11.2026):**
- Şəkil: `POST /api/v1/images` → `data[i].b64_json` + `media_type`. 71 model (`/api/v1/images/models`).
- Video: `POST /api/v1/videos` → `{id, status:"pending"}`; `GET /api/v1/videos/{id}` → status
  (`pending → in_progress → completed / failed / cancelled / expired`); fayl
  `GET /api/v1/videos/{id}/content?index=0` (API açarı ilə). Model imkanları `GET /api/v1/videos/models`
  (`supported_durations`, `supported_resolutions`, ...).
- Səs: `POST /api/v1/audio/speech` → xam audio bayt. `response_format` default `pcm`-dir, server
  həmişə `mp3` istəyir. Gemini TTS və HeyGen yalnız `pcm` verir — bu server onları qəbul etmir
  (PCM-in sample rate-i sənəddə yazılmayıb, təxmin etmirəm).

**LibreChat (mənbə kodu, v0.8.9, `packages/api/src/mcp/parsers.ts`):**
- MCP `image` (base64) nəticəsi chat-da şəkil kimi göstərilir; yalnız URL olan şəkil göstərilmir.
  Limit 10 MB → server böyük şəkilləri avtomatik JPEG-ə sıxır, orijinalı link kimi verir.
- `audio` tipli nəticəni LibreChat tanımır — base64 mətn kimi modelə gedir. Ona görə video və səs
  fayl kimi saxlanır, `/media` ünvanından verilir və `ui://` HTML pleyer (`<video>`/`<audio>`)
  qaytarılır; LibreChat bunu model cavabında `\ui{...}` markerinin yerində göstərir.
- LibreChat-ın öz `formatToolContent` funksiyası ilə yoxlanılıb: şəkil → 1 şəkil artefaktı,
  video/səs → 1 UI resource + marker, HTML modelə sızmır.
- SSRF qorunması daxili Docker ünvanını default bloklayır → `mcpSettings.allowedAddresses` lazımdır.

## Alətlər

| Alət | Nə edir |
|---|---|
| `generate_image` | Şəkil (aspect_ratio, resolution, n, istinad şəkil URL-ləri) |
| `generate_video` | Video; 4 dəqiqəyə qədər gözləyir, hazır olmasa job_id qaytarır |
| `check_video_status` | job_id ilə nəticəni alır (yalnız job-u yaradan istifadəçi) |
| `generate_speech` | Mətndən MP3 səs + pleyer |
| `list_media_models` | İcazəli modellər, parametrlər, səslər |
| `assemble_short` | Səhnələr + səsləndirmə + altyazı → hazır 1080x1920 MP4 (Shorts/TikTok/Reels), ffmpeg, AI xərci yoxdur |
| `social_connect_account` | İstifadəçiyə öz YouTube/TikTok/Instagram… hesabını qoşmaq üçün link (Zernio OAuth) |
| `social_list_accounts` | İstifadəçinin YALNIZ öz qoşulmuş hesabları |
| `social_publish` | İndi paylaş / vaxta planla / qaralama — yalnız öz hesablarına, yalnız bu serverin yaratdığı media |

Qoruma: X-API-Key gizli açarı, admin tərəfindən sabitlənmiş model siyahısı, hər istifadəçiyə
gündəlik limit (X-User-ID), video uzunluğu/keyfiyyət tavanı, `usage.jsonl`-da hər çağırışın
OpenRouter xərci.

## Avtomatik quraşdırma (LibreChat deploy-compose: LibreChat-API + LibreChat-NGINX)

`.env` doldurulduqdan sonra:
```bash
cd /root/LibreChat
bash openrouter-media-mcp/deploy/install-librechat-docker.sh
```
Skript backup götürür, konteyneri LibreChat şəbəkəsində işə salır, `librechat.yaml` və nginx-ə
əlavələr edir, LibreChat-API-ni yenidən başladır və yoxlayır. Səhv olsa geri qaytarır.
Təkrar işə salmaq təhlükəsizdir.

## Əl ilə quraşdırma (VPS, LibreChat Docker ilə)

1. Bu qovluğu (`openrouter-media-mcp/`) LibreChat-ın `docker-compose.yml` olan qovluğuna köçür.
2. `.env.example` → `.env`, doldur:
   - `OPENROUTER_API_KEY`
   - `MCP_SHARED_SECRET` → `openssl rand -hex 32` ilə yarat
   - `PUBLIC_BASE_URL=https://velorafy.com/mcp-media`
3. `deploy/docker-compose.override.example.yml`-i LibreChat qovluğuna `docker-compose.override.yml`
   kimi qoy (artıq override varsa, `openrouter-media` servisini ona əlavə et).
4. LibreChat-ın `.env` faylına: `OPENROUTER_MEDIA_SECRET=<MCP_SHARED_SECRET ilə eyni dəyər>`
5. `deploy/librechat.example.yaml`-dakı `mcpSettings` və `mcpServers` hissələrini `librechat.yaml`-a əlavə et.
   Endpoint adını dəyişmək lazım deyil.
6. `deploy/nginx.example.conf`-dakı `location` blokunu nginx-ə əlavə et, `nginx -t && systemctl reload nginx`.
7. İşə sal:
   ```bash
   docker compose up -d --build
   docker logs openrouter-media      # "listening on :3400" görünməlidir
   curl -I https://velorafy.com/mcp-media/media/test   # 404 = yol işləyir
   ```
8. Agent Builder → yeni agent → Tools → `openrouter-media` alətləri →
   Instructions: `deploy/agent-prompt.md`.

## Creator Studio (avtopilot: ideya → hazır video → paylaşım)

**Necə işləyir:** agent ssenari yazır → `generate_image` ilə 9:16 səhnələr → `generate_speech` ilə səs →
`assemble_short` hamısını altyazılı bir videoya yığır → istifadəçi təsdiqləyəndən sonra `social_publish`.
Agentin təlimatı: [`deploy/creator-agent-prompt.md`](deploy/creator-agent-prompt.md).

**assemble_short**
- Yalnız bu serverin öz `/media/` faylları qəbul olunur (kənar URL, `../` hiylələri rədd edilir).
- Səs səhnələrdən uzundursa, son səhnə səs bitənə qədər uzadılır — nitq kəsilmir.
- Altyazı ASS ilə yandırılır (DejaVu Sans Bold; ə, ğ, ş, ç, ı, ö, ü düzgün görünür).
- `MAX_CONCURRENT_RENDERS=1` — kiçik droplet-də eyni anda bir video kodlanır, qalanlar növbə gözləyir.

**Paylaşım (Zernio, multi-tenant)**
1. zernio.com-da qeydiyyat → API açarı (`sk_...`) → `.env`-də `ZERNIO_API_KEY`.
2. Hər LibreChat istifadəçisi üçün avtomatik ayrıca Zernio profili yaradılır (`externalId` = istifadəçi id).
3. İstifadəçi hesabını Zernio-nun OAuth linki ilə özü qoşur — parolunu biz görmürük.
4. Zernio `/v1/posts` iş sahəsindəki İSTƏNİLƏN hesabı qəbul edir; ona görə server hər paylaşımdan
   əvvəl hər `account_id`-nin bu istifadəçinin profilinə aid olduğunu yoxlayır.
5. `SOCIAL_POST_FEE_USD` — Zernio xərcini müştəriyə ötürmək üçün hər hesaba hər paylaşımda tutulan
   məbləğ (× `COST_MARKUP`). Tam uğursuz paylaşım (HTTP 207, status `failed`) pulsuzdur.

**Diqqət:** Zernio-nun pulsuz planı 2 sosial hesabla məhdudlaşır (bütün istifadəçilər birlikdə) —
real müştərilər gələndə hesab başına ödənişli plana keçmək lazımdır. `SOCIAL_PLATFORMS`-ə yeni
platforma əlavə etməzdən əvvəl Zernio sənədində onun dəqiq id-sini yoxla.

## Kredit yoxlaması (LiteLLM limiti ilə)

Media alətləri OpenRouter-ə birbaşa gedir, LiteLLM-i görmür. Ona görə server istifadəçinin limitini özü yoxlayır:

`qalan = max_budget − spend (LiteLLM /customer/info) − bu serverin media üçün çıxdığı məbləğ`

- Customer ID = LibreChat user ID (`X-User-ID`), eyni ID LiteLLM-də `x-litellm-customer-id` kimi gedir.
- Pulsuz plan (customer-də `models` siyahısı doludur, məs. `[gemma]`) və ya limiti çatmayan istifadəçi OpenRouter çağırılmamış rədd edilir.
- Şəkil: real xərc (`usage.cost`) × `COST_MARKUP` çıxılır. Video: göndərilərkən təxmini məbləğ tutulur, tamamlananda real xərclə düzəldilir, alınmasa geri qaytarılır. Səs: OpenRouter xərc qaytarmır, təxmini məbləğ (`ESTIMATE_TTS_USD_PER_1K_CHARS`) çıxılır.
- Ödəniş edəndə billing `max_budget`-i artırır, hesab dərhal yenilənir. Paralel sorğular eyni krediti iki dəfə xərcləyə bilmir.
- LiteLLM cavab vermirsə, heç nə yaradılmır (fail closed).
- Media xərci LiteLLM panelində görünmür, `usage.jsonl` və `state.json`-dadır (LiteLLM-ə spend yazmaq olmur, yoxlanılıb: `/customer/update` `spend`-i qəbul etmir).

Yalnız `/customer/info` çağıra bilən açar (master açar yox!) LiteLLM serverində belə yaradılır:

```bash
MK=$(docker exec litellm-litellm-1 printenv LITELLM_MASTER_KEY)
curl -s -X POST http://localhost:4000/key/generate -H "Authorization: Bearer $MK" -H "Content-Type: application/json" \
  -d '{"key_alias":"mcp-media-readonly","allowed_routes":["/customer/info"],"max_budget":0.01}'
unset MK
```

Açarı `.env`-də `LITELLM_CUSTOMER_KEY`, LiteLLM ünvanını `LITELLM_URL` kimi yaz.

## Test

```bash
npm install && npm test     # saxta OpenRouter serverinə qarşı 13 başdan-sona yoxlama
```

## Bilməli olduğun məhdudiyyətlər

- **Xərc LibreChat kreditindən çıxılmır.** LibreChat balansı yalnız model tokenlərini sayır; MCP
  alətinin OpenRouter xərci birbaşa sənin hesabından gedir. Gündəlik limitlər əsas qorumadır.
  Nümunə: `google/veo-3.1-lite`, 720p, 8 san ≈ $0.40 (səslə) / ≈ $0.24 (səssiz) — OpenRouter-in
  `/videos/models` qiymətlərinə görə. Real xərclər:
  `docker exec openrouter-media cat /data/state/usage.jsonl`
- Video/səs pleyeri modelin `\ui{...}` markerini cavabına yazmasından asılıdır. Yazmasa da,
  birbaşa yükləmə linki cavabda olur.
- İstifadəçinin chat-a yüklədiyi şəkli alət birbaşa götürə bilmir (istinad üçün public URL lazımdır).
- Speech-to-text daxil edilməyib — LibreChat-ın öz STT ayarı var.
- `/media` faylları `MEDIA_TTL_DAYS` (30) gündən sonra silinir; köhnə söhbətlərdə video açılmaz.
- LibreChat v0.8.9 kodu ilə yoxlanılıb. Köhnə versiyada `allowedAddresses` yoxdursa, LibreChat-ı yenilə.
