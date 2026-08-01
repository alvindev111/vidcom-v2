# 11 — Logic parse composition (phần khó nhất khi viết lại)

Đây là **giá trị kỹ thuật lõi** của app: biến một file HTML animation thành mô hình scene/timeline có thể hiển thị và sửa. Nếu viết lại backend, đây là phần phải port chính xác nhất.

File liên quan: [projects.server.ts](../../src/lib/hyperframes/projects.server.ts), [scenes.server.ts](../../src/lib/hyperframes/scenes.server.ts), [scene-elements.server.ts](../../src/lib/hyperframes/scene-elements.server.ts), [root-track.server.ts](../../src/lib/hyperframes/root-track.server.ts), [composition-root.server.ts](../../src/lib/hyperframes/composition-root.server.ts), [sdk.server.ts](../../src/lib/hyperframes/sdk.server.ts)

---

## 0. Điều kiện tiên quyết: DOMParser shim

```js
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;  // từ linkedom
}
```
`@hyperframes/parsers` đọc composition bằng `DOMParser` của DOM — không tồn tại trong Node. CLI của hyperframes cũng cài linkedom làm global vì lý do này. **Bắt buộc** phải làm, và **chỉ một bản linkedom** (đó là lý do `next.config.ts` để `linkedom` trong `serverExternalPackages`).

---

## 1. Đọc metadata composition — và tại sao không dùng API của package

`readComposition(html)` ([projects.server.ts:127](../../src/lib/hyperframes/projects.server.ts#L127)) tự parse thay vì dùng `parseHtml()`/`extractCompositionMetadata()` của `@hyperframes/parsers`.

Comment ghi lý do rất cụ thể — trên các project này, API của package trả:
- `resolution: "portrait"` cho document 1920×1080
- composition id = `null`
- duration = `null`
- element name lấy từ source GSAP inline (sai)

Sự thật authored nằm ở **hợp đồng `data-*` trên chính element**, và `readClipTiming` (của `@hyperframes/core`) là hàm decode nó — bao gồm legacy `data-end`/`data-layer` và tham chiếu `data-start`.

```js
readComposition(html) → {
  id:       root.getAttribute("data-composition-id"),
  width:    parseNumeric(root.getAttribute("data-width")),
  height:   parseNumeric(root.getAttribute("data-height")),
  duration: rootTiming.duration ?? rootTiming.end,
  clips:    nestedHosts(hosts, root)   // đã bỏ field `element`
}
```

### Xác định root
```js
rootHost(hosts) = hosts.find(h => h.hasAttribute("data-width") && h.hasAttribute("data-height")) ?? hosts[0]
```
⚠️ Điểm dễ vỡ: `grain-overlay` trong `warm-grain` **cũng có** `data-width`/`data-height`, nó không thành root chỉ vì `main-composition` đứng trước trong document order.

**Đề xuất backend mới:** root = composition host **không có** composition host cha nào (`nearestHost(node) === null`). Chặt chẽ hơn và độc lập thứ tự.

### Nested hosts = scenes
```js
nestedHosts(hosts, root) = hosts
  .filter(h => h !== root)
  .map(h => ({ id, src: data-composition-src, start: timing.start ?? 0,
               duration: timing.duration ?? timing.end ?? 0,
               trackIndex: timing.trackIndex, element: h }))
  .sort((a,b) => b.trackIndex - a.trackIndex)   // trackIndex GIẢM DẦN
```
Lưu ý: sort **giảm dần** ở đây (lớp trên trước), nhưng `scene-order.ts` sort **tăng dần**. Hai thứ tự khác nhau cho hai mục đích khác nhau.

---

## 2. Lấy subtree đúng của một sub-composition

`compositionRoot(raw)` ([composition-root.server.ts:13](../../src/lib/hyperframes/composition-root.server.ts#L13)):
```js
const { document } = parseHTML(raw);
const template = document.querySelector("template");
return (template?.content as ParentNode) ?? document.body;
```

**Bắt buộc**: sub-composition được viết theo 2 dạng — document đầy đủ, **hoặc** bọc trong `<template>`. Linkedom giữ children của template trong `.content`, nên `document.body` walk **không tìm thấy gì cả** ở dạng bọc — mà đó chính là dạng các project scaffold dùng. Bỏ bước này = media và element của scene mất sạch.

`inlineScripts(root)`:
```js
[...root.querySelectorAll("script")]
  .filter(s => !s.getAttribute("src"))            // bỏ script external (GSAP CDN)
  .map(el => ({ element: el, source: el.textContent ?? "" }))
  .filter(({source}) => source.trim().length > 0)
```
`element` được giữ lại để biết script **thuộc composition nào** — script nằm trong một sub-composition host thuộc scene đó, không thuộc document quanh nó.

---

## 3. `readScenes(slug)` — dựng `Scene[]`

Với mỗi nested host:

```
hostFile = "index.html"; root = host.element; block = null

nếu host.src:
    file = <dir>/<src>
    nếu file tồn tại:
        raw      = readFileSync(file)
        hostFile = src
        root     = compositionRoot(raw)         ← xử lý <template>
        marker   = raw.match(/<!--\s*hyperframes-registry-item:\s*([\w-]+)\s*-->/)
        nếu marker && registryBaseUrl: block = await readBlock(registryBaseUrl, marker[1])   ← HTTP
        nếu marker mà không có registry:  block = { name: marker[1], ...tất cả null/[] }

trả Scene {
  id, src, start, duration, trackIndex, block,
  isTransition: block?.category === "transitions" || block?.tags.includes("transition"),
  media:     collectMedia(slug, hostFile, root),
  script:    await readSceneScript(slug, {id, src}),     ← qua SDK, không phải DOM walk
  narration: readNarration(slug, host.id),
  ...readSceneElements(root, host.id)                     ← elements + unresolvedEffects
}
```

Toàn bộ chạy trong một `Promise.all` → các scene parse song song.

### `readBlock` — tra registry qua HTTP
```js
key = `${registryBaseUrl}#${name}`
cached = blockCache.get(key); nếu !== undefined → trả về (kể cả null)
fetch(`${registryBaseUrl}/blocks/${name}/registry-item.json`, { signal: AbortSignal.timeout(4000) })
  ok  → { name, title, description, category: resolveBlockCategory(tags), tags }
  fail/throw → { name, title:null, description:null, category:null, tags:[] }   // fail mềm
blockCache.set(key, block)
```
`resolveBlockCategory` chỉ có ở subpath `@hyperframes/core/registry`, không ở package root.

**Vấn đề:** cache process-lifetime không TTL; timeout 4s **mỗi block lạ** → load trang có thể chậm nhiều giây khi offline; response HTTP không ok (404) cũng cache lại `null` mãi mãi.

### `collectMedia` — resolve URL media
```js
nodes = root.querySelectorAll("img, video, audio, source")
với mỗi node:
   owner = (tag === "SOURCE") ? node.parentElement : node
   kind  = { IMG:"image", VIDEO:"video", AUDIO:"audio" }[owner.tagName]   // khác → bỏ
   src   = node.getAttribute("src")                                       // rỗng → bỏ
   timing = readClipTiming(owner)
   url = absolute/data: ? src
         : `/api/hf/${slug}/files/` + posix.normalize(posix.join(dirname(hostFile), src))
```
Resolve theo **thư mục của file composition sở hữu**, không theo project root — quan trọng vì `compositions/intro.html` viết `../assets/x.svg`.

---

## 4. `readSceneElements(root, compositionId, owns?)` — phần phức tạp nhất

Hai pass trả lời hai nửa khác nhau của câu hỏi: **DOM cho biết element nào chiếm slot trên timeline**, **script GSAP cho biết motion nào áp lên chúng**.

### Pass 1 — DOM
```js
TIMED_SELECTOR = "[data-start],[data-duration],[data-end],.clip,img,video,audio"

với mỗi node khớp:
   nếu node.hasAttribute("data-composition-id") → SKIP   // host là scene riêng, có lane riêng
   nếu !owns(node) → SKIP                                 // chỉ dùng cho root track
   kind = {IMG:"image",VIDEO:"video",AUDIO:"audio"}[tag] ?? "element"
   key  = id ? `#${id}` : `${tag.toLowerCase()}:${rows.size}`
   hasOwnTiming = có data-start | data-duration | data-end
   rows.set(key, {
     id: key, label: id ?? tag.toLowerCase(), kind,
     start:    hasOwnTiming ? (timing.start ?? 0) : null,
     duration: hasOwnTiming ? (timing.duration ?? timing.end ?? null) : null,
     src: node.getAttribute("src"), effects: [] })
```
Quy tắc quan trọng: **timing chỉ được ghi khi tác giả thực sự viết nó**. Element media không có timing và không có tween thì hoàn toàn không mang thông tin thời gian → bị loại ở bước cuối; nó thuộc danh sách media của scene, không thuộc trục thời gian.

Fallback key `tag:index` dùng `rows.size` → **không stable** giữa các lần parse nếu DOM đổi.

### Pass 2 — GSAP
```js
với mỗi (index, {element, source}) của inlineScripts(root):
   nếu !owns(element) → SKIP
   try { animations = parseGsapScript(source).animations } catch { CONTINUE }   // script lỗi không được giết cả scene

   với mỗi animation:
      nếu animation.hasUnresolvedSelector || animation.resolvedStart === undefined:
          unresolvedEffects += 1; CONTINUE                  // ĐẾM, KHÔNG ĐOÁN
      key = normalizeTarget(animation.targetSelector, compositionId)
      row = rows.get(key) ?? { id:key, label:key, kind:"element", start:null, duration:null, src:null, effects:[] }
      rows.set(key, row)
      row.effects.push({
        id: `${index}:${animation.id}`,      // scope theo script index — xem dưới
        method: animation.method,
        start: animation.resolvedStart,
        duration: animation.duration ?? 0,
        ease: animation.ease ?? null,
        propertyGroup: animation.propertyGroup ?? null })
```

**Tại sao `id` phải scope theo script index:** parser đánh số tween **theo từng script** (ví dụ `#stat1-to-4250`), nên scene có 2 timeline sẽ trả cùng một id hai lần → duplicate React key trên timeline.

**`normalizeTarget(selector, compositionId)`:**
```js
selector.replace(`[data-composition-id="${compositionId}"]`, "")
        .replace(`#${compositionId}`, "")
        .trim() || selector
```
Sub-composition scaffold scope selector theo composition id (`[data-composition-id="intro"] .title-card`); bỏ prefix để `#stat1` trong tween khớp đúng row `#stat1` của DOM pass, thay vì mở row thứ hai cho cùng element.

### Bước kết
```js
elements = [...rows.values()]
  .filter(r => r.effects.length > 0 || r.start !== null)      // bỏ row không có thông tin thời gian
  .map(r => ({...r, effects: [...r.effects].sort((a,b) => a.start - b.start)}))
  .sort((a,b) => firstMoment(a) - firstMoment(b))

firstMoment(row):
   effect = min(effect.start) hoặc null
   nếu row.start === null → effect ?? 0
   nếu effect === null    → row.start
   ngược lại              → min(row.start, effect)
```

---

## 5. `readRootTrack(slug)` — track riêng của entry document

```js
parse index.html
hosts = [...document.querySelectorAll("[data-composition-id]")]
root  = hosts.find(có data-width && data-height) ?? hosts[0]
nếu !root → null

readSceneElements(document.body, root.compositionId, owns = node => {
   owner = nearestHost(node)          // leo parentElement tìm [data-composition-id] gần nhất
   return owner === null || owner === root
})

nếu elements.length === 0 && unresolvedEffects === 0 → null
trả { id, duration: timing.duration ?? timing.end ?? 0, elements, unresolvedEffects }
```

Quét **`document.body`**, không phải root host — media viết như sibling của root vẫn phát như phần của composition này (đó là chỗ A-roll `<video>` được đặt để tránh lint rule `video_nested_in_timed_element` của HyperFrames).

Ownership quyết định bởi `nearestHost`, **không phải độ sâu**.

---

## 6. `readSceneScript` qua SDK — tại sao không dùng DOM walk

```js
file = scene.src ?? "index.html"
opened = openComposition(readFileSync(file))
roots = opened.composition.getRootElements()
nếu scene.src → scriptLines(roots, file)                       // cả file thuộc scene
ngược lại     → scriptLines(findByCompositionId(roots, scene.id).children, file)   // chỉ subtree host
finally → composition.dispose()
```

`scriptLines(elements, file, acc)`:
```
với mỗi element:
   tag ∈ {script, style, template} → SKIP
   text = (element.text ?? "").replace(/\s+/g," ").trim()
   nếu element.children.length === 0:        // LEAF
       nếu 1 < text.length < 400 → acc.push({ id: element.scopedId, text, file })
   ngược lại → đệ quy children
```

Lý do dùng SDK (comment [scenes.server.ts:162](../../src/lib/hyperframes/scenes.server.ts#L162)): "Script lines come from the SDK so each one carries the hf-id that setText needs — the DOM walk here has no stable element identity."

`element.scopedId` = `data-hf-id`, đã scope cho element trong sub-composition. Đây là **định danh duy nhất** mà `setText` chấp nhận.

**Chi phí:** mỗi scene = 1 lần `openComposition` (parse + stamp hf-id) + `dispose`. Với 5 scene = 5 lần parse thêm, **cộng vào** các lần parse của `readScenes`/`readRootTrack`/`readProject`.

---

## 7. Ghi qua SDK

```js
save(path, composition) {
  writeFileSync(path, composition.serialize(), "utf8");
  composition.dispose();
}
```

`serialize()` **re-emit document từ DOM**:
- `<script>` / `<style>` giữ nguyên nội dung
- indentation **bị chuẩn hoá**
- `data-hf-id` **bị stamp vào** mọi element

Comment: "the same trade the official studio makes when it saves."

Mọi op đều qua `can()` trước:
```js
const check = composition.can(op);
if (!check.ok) { composition.dispose(); return { ok:false, error: check.message ?? "edit rejected by the SDK" }; }
```

Headless mode (không có persist adapter) — SDK chỉ là transform + serializer, module tự ghi, nên edit lỗi **không để lại file nửa vời**.

Op đang dùng: `setTiming`, `setText`, `addElement`. SDK có nhiều op hơn (chưa dùng).

---

## 8. Helper phụ

### `foldableLines(code)` — [projects.server.ts:380](../../src/lib/hyperframes/projects.server.ts#L380)
```js
lines.reduce((acc, line, i) => {
  const next = lines[i+1];
  if (line.trim() && next?.trim() && indent(next) > indent(line)) acc.push(i+1);
  return acc;
}, [])
```
Dòng nào có indent nhỏ hơn dòng kế = mở block. **Hiện không ai dùng** (CodeMirror tự fold) — di sản của `code-view.tsx` đã xoá.

### `fileVersion(target)`
```js
`${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}`
```

### `readProjectTree` — bỏ `node_modules`, `.git`, `.hyperframes`; sort folder trước file rồi `localeCompare`.

---

## 9. Danh sách chi phí parse cho MỘT lần load studio

| Bước | Số lần parse HTML | Ghi chú |
|---|---|---|
| `readProject` → `readComposition` | 1 (`index.html`) | linkedom |
| `readSourceFile("index.html")` | 0 | chỉ đọc text |
| `readProjectTree` | 0 | readdir đệ quy |
| `readScenes` → `readCompositionHosts` | 1 (`index.html`) | linkedom |
| `readScenes` → mỗi scene có `src` | 1/scene (`compositionRoot`) | linkedom |
| `readScenes` → `readSceneScript` mỗi scene | 1/scene (`openComposition`) | SDK, nặng hơn |
| `readScenes` → `readBlock` mỗi block lạ | HTTP ra registry, timeout 4s | có cache |
| `readRootTrack` | 1 (`index.html`) | linkedom |
| `readPreviewSettings` | 0 | JSON |

Với project 5 scene (4 có `src`): **~3 + 4 + 5 = 12 lần parse** + tối đa vài HTTP call.

> **Đã giảm nhẹ.** Cả 5 read nặng (`readProject`, `buildPreviewHtml`, `readProjectTree`, `readRootTrack`, `readScenes`) nay được bọc `memoPerProject()`, invalidate bằng fingerprint `path:mtimeMs:size` toàn cây. Nên 12 lần parse chỉ xảy ra khi **project thực sự đổi trên đĩa**, không phải mỗi request.
>
> Hai chi phí còn lại: (a) `projectFingerprint()` duyệt + `stat` toàn bộ cây, gọi 5 lần mỗi lần render trang; (b) đổi **một** byte trong project làm invalidate **toàn bộ** 5 cache, kể cả thứ không liên quan (sửa `preview-settings.json` cũng làm `readScenes` parse lại).

---

## 10. Khuyến nghị cho backend mới

1. **Parse một lần, dùng nhiều lần.** Dựng một `CompositionModel` duy nhất từ `index.html` + tất cả sub-composition; mọi hàm (`readProject`, `readScenes`, `readRootTrack`) đọc từ model đó. `memoPerProject()` hiện tại memo **kết quả từng hàm**, chưa memo **model chung** — vẫn còn 5 lần fingerprint và mỗi hàm vẫn tự parse lại khi miss. Giữ ý tưởng, nâng lên một tầng, và invalidate bằng **event của file watcher** thay vì `stat` toàn cây. Cache theo content hash, không theo mtime+size.
2. **Xác định root tường minh** (`nearestHost === null`) thay vì "phần tử đầu có width+height".
3. **Element key stable**: `tag:index` theo `rows.size` sẽ thay đổi khi DOM đổi. Dùng path trong DOM tree hoặc bắt buộc `id`/`data-hf-id`.
4. **Giữ nguyên nguyên tắc "đếm, không đoán"** cho `unresolvedEffects`. Đây là quyết định thiết kế đúng.
5. **Giữ nguyên `compositionRoot()`** xử lý `<template>` — bỏ là mất dữ liệu.
6. **Giữ `readClipTiming` của `@hyperframes/core`** — nó xử lý legacy attribute mà tự viết lại sẽ bỏ sót.
7. **registry cache** cần TTL + persist (không parse lại mỗi khởi động) + không cache negative vô hạn.
8. **Trả về entity đã cập nhật** sau mỗi write để client không phải re-parse toàn bộ project.
9. **File watcher + invalidate cache** thay vì `no-store` + refresh toàn trang.
10. **Ghi atomic** (temp + rename) và giữ revision history.
11. **Bịt path traversal** ở `openProjectFile` (action `script`).
