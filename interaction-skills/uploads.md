---
title: File Uploads
tags: [upload, file-input, dom]
---

# File Uploads

Three layers, each appropriate for a different page design:

| Page pattern | Brisk approach |
|---|---|
| `<input type="file">` | `upload_file {selector, paths}` (uses `DOM.setFileInputFiles`) |
| Drag-and-drop only | Coordinate-based drag (see `drag-and-drop.md`) |
| API-driven (no input, no drop) | `cdp Network.continueRequest` to inject the upload bytes |

## Direct (the 80% case)

```text
upload_file {selector: "input[type=file]", paths: ["C:/path/to/photo.jpg"]}
```

That's it. CDP's `DOM.setFileInputFiles` accepts absolute paths only —
relative paths are silently rejected. On Windows, double-backslash or
forward-slash both work.

**Multiple files:**

```text
upload_file {selector: "input[multiple]", paths: ["/a.jpg", "/b.jpg"]}
```

The input must already have the `multiple` attribute or only the first
file is accepted.

## Hidden inputs

Most modern UI hides the actual `<input type="file">` behind a styled
button. `display: none` is fine — `DOM.setFileInputFiles` doesn't care.

```html
<button onclick="document.querySelector('input').click()">Choose photo</button>
<input type="file" style="display: none">
```

Skip the button — call `upload_file` directly against the hidden input.

## Drag-and-drop zones

Some sites accept files **only** via drag-and-drop (no `<input>`).
Approach:

1. Pick a stable file with a known MIME type and read it as bytes.
2. Build a synthetic `DataTransfer` in the page:

```javascript
const dt = new DataTransfer();
const blob = new Blob([new Uint8Array(/* … */)], {type: 'image/png'});
const file = new File([blob], 'photo.png', {type: 'image/png'});
dt.items.add(file);

const target = document.querySelector('.dropzone');
target.dispatchEvent(new DragEvent('dragenter', {dataTransfer: dt, bubbles: true}));
target.dispatchEvent(new DragEvent('dragover',  {dataTransfer: dt, bubbles: true}));
target.dispatchEvent(new DragEvent('drop',      {dataTransfer: dt, bubbles: true}));
```

Then verify the upload via a screenshot or by checking the form state.

**Pitfall:** many drag-drop libraries (react-dropzone, filepond) use
custom event names like `paste` or check `event.isTrusted`. Synthetic
events have `isTrusted: false`. If the drop is rejected, you may need
the coordinate-based real drag in `drag-and-drop.md`.

## Bytes from `http_get`

For "download from URL X, then upload to Y" without ever materialising
the file:

```text
1. http_get {url: "https://source/file.png", maxLength: 10485760}
2. js {expression: `(async () => {
     const r = await fetch('${returned_data_url}');
     const blob = await r.blob();
     const dt = new DataTransfer();
     dt.items.add(new File([blob], 'a.png', {type: blob.type}));
     document.querySelector('input[type=file]').files = dt.files;
   })()`}
```

Cleaner alternative: write the bytes to a temp file (`os.tmpdir()`) and
use `upload_file`. Less rope to give the LLM.

## Verifying the upload

After `upload_file`, the input's `files` collection is populated but no
network call has fired. The site's JS still has to submit the form.

```text
1. upload_file
2. capture_screenshot — confirm the preview / filename appears
3. click_at_xy on submit button
4. wait_for_load OR get_console_logs {search: "upload"}
```

If the form submits via XHR / fetch, `wait_for_network_idle` is more
reliable than `wait_for_load`.
