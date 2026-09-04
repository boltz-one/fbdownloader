# FB Video Downloader

Chrome extension (Manifest V3) bắt link video / Reels Facebook và tải về ở chất lượng cao nhất.

## Cài đặt

1. Giải nén thư mục này ra một chỗ cố định (đừng để trong Downloads rồi xoá).
2. Mở Chrome → `chrome://extensions`
3. Bật **Developer mode** (góc trên bên phải)
4. Bấm **Load unpacked** → chọn thư mục `fb-video-downloader`
5. Ghim icon extension ra thanh công cụ cho tiện

## Dùng thế nào

1. Mở video hoặc Reel trên Facebook, **bấm play** cho nó chạy vài giây — extension chỉ đọc được
   link sau khi Facebook thực sự nạp dữ liệu video.
2. Hoặc bấm nút **“Tải video”** nổi ở góc trên bên phải khung hình, hoặc bấm icon extension.
3. Chọn chất lượng:
   - **HD / SD** — link MP4 progressive, tải thẳng, nhanh nhất.
   - **★ Tối đa** — mở trang riêng, tải luồng DASH bitrate cao nhất (hình + tiếng tách rời)
     rồi ghép lại thành MP4 ngay trong trình duyệt bằng ffmpeg.
4. File lưu vào `Downloads/FBVideo/`.

## Vì sao có hai chế độ

Facebook phát cùng một video theo hai cách:

| | MP4 progressive | DASH |
|---|---|---|
| Nội dung | 1 file có sẵn hình + tiếng | hình và tiếng là 2 file riêng |
| Chất lượng | thường 720p, đôi khi 1080p | bitrate cao nhất Facebook có, thường 1080p+ |
| Tải | 1 request, xong ngay | tải 2 file rồi phải mux |

Nút **★ Tối đa** đọc DASH manifest, liệt kê mọi luồng, mặc định chọn luồng cao nhất,
rồi chạy `ffmpeg -c copy` — copy stream chứ không encode lại, nên **không mất chất lượng**
và không tốn thời gian encode.

## Cấu trúc

```
manifest.json
background.js            service worker: lưu link theo tab, xử lý tải, đặt tên file
content/injector.js      chạy trong MAIN world, hook fetch/XHR, quét JSON của Facebook
content/content.js       cầu nối sang extension + nút nổi trên video (shadow DOM)
popup/                   danh sách video bắt được trên tab hiện tại
downloader/              trang tải DASH + ghép MP4 bằng ffmpeg.wasm
vendor/ffmpeg, vendor/core   @ffmpeg/ffmpeg 0.12.15 + @ffmpeg/core 0.12.10 (bản ESM)
```

## Ghi chú kỹ thuật

- Không có server, không gửi dữ liệu đi đâu. `host_permissions` chỉ gồm `facebook.com` và `fbcdn.net`.
- ffmpeg chạy hoàn toàn local bằng WebAssembly (`wasm-unsafe-eval` trong CSP của extension pages).
- Bản ffmpeg core nặng ~32 MB nên thư mục giải nén khá to; đó là toàn bộ lý do file zip lớn.
- Extension xoá danh sách link mỗi khi tab điều hướng sang trang mới.
- Nếu ghép lỗi, trang tải vẫn cho phép lưu riêng file hình và file tiếng để ghép bằng ffmpeg/VLC.

## Giới hạn đã biết

- Video **private / trong group kín** vẫn tải được nếu tài khoản bạn xem được, vì extension
  dùng đúng link mà trình duyệt bạn đang phát.
- Video **live đang phát** thì manifest thay đổi liên tục, chỉ tải được phần đã lưu.
- Nếu Facebook đổi tên field trong GraphQL, sửa `PROGRESSIVE_KEYS` trong `content/injector.js`.
  Có sẵn lớp dự phòng quét thô bằng regex tìm `.mp4` nên thường vẫn chạy.

Chỉ tải nội dung bạn có quyền sử dụng — video của chính bạn, hoặc nội dung bạn đã được phép lưu.

## Changelog

### 1.0.1 — sửa lỗi không bắt được link
Ba lỗi tìm được khi chạy thật trên `facebook.com/reel/…`:

1. **URL không có đuôi `.mp4`.** Facebook đã chuyển sang link dạng
   `scontent.<region>.fna.fbcdn.net/o1/v/t2/f2/m412/AQ…` — bộ lọc cũ bắt buộc phải có
   `.mp4` nên loại sạch. Nay tách làm hai: kiểm tra chặt cho lớp quét regex dự phòng,
   kiểm tra lỏng (chỉ cần là host fbcdn/fbsbx) cho giá trị đọc từ các key đã tin cậy.
2. **Sai tên field DASH.** Facebook dùng `dash_manifests: [{ manifest_xml }]`, code cũ
   dò `manifest_xml_string`. Nay không đoán tên field nữa mà tìm thẳng chuỗi nào trông
   giống MPD trong object.
3. **Quét inline script quá sớm.** Script do trình phân tích HTML chèn vào sẽ bắn
   MutationObserver ngay lúc thẻ được append, khi phần text bên trong còn rỗng — đọc
   `textContent` lúc đó ra chuỗi trắng. Thêm nữa Reels chỉ nạp dữ liệu clip kế tiếp khi
   cuộn tới. Nay dùng WeakSet + quét lại định kỳ (1s trong 30s đầu, sau đó 4s), và nút ⟳
   ép quét lại toàn bộ từ đầu.

### 1.0.2 — sửa lỗi mất link sau vài giây
Bắt link đã chạy đúng ở 1.0.1, nhưng link vẫn biến mất trước khi bấm được. Hai nguyên nhân:

1. **Service worker bị Chrome thu hồi.** MV3 tắt service worker sau khoảng 30 giây không hoạt
   động, xoá sạch state ở cấp module — nên cái `Map` giữ danh sách link bốc hơi trước khi
   người dùng kịp bấm nút. Nay lưu trong `chrome.storage.session`: vẫn nằm trong RAM, không
   ghi ra đĩa, sống qua các lần service worker khởi động lại, tự mất khi đóng trình duyệt.
2. **Tự xoá state của chính mình.** Handler `tabs.onUpdated` xoá danh sách mỗi khi tab báo
   `status: 'loading'`. Sự kiện đó có thể đến *sau* khi content script ở `document_start` đã
   gửi lô link đầu tiên — thế là xoá đúng thứ vừa bắt được. Vì `seenPayloads` chặn phân tích
   lại cùng một payload nên nó không bao giờ hồi phục. Bỏ hẳn, thay bằng giới hạn số record
   và xoá khi tab đóng.

### 1.0.3 — sửa lỗi "tải được nhưng không có hình"
File ghép ra vốn không hỏng — vấn đề là **codec**. Facebook ngày càng phát DASH bằng VP9 và
AV1; luồng 1080p của reel trong lúc thử nghiệm là `vp09`, và một video khác trên cùng trang
chỉ có `av01` từ 720p đến 1440p. Cả hai đều nằm hợp lệ trong MP4 và chạy tốt trên Chrome, VLC,
nhưng Windows Media Player, Photos và QuickTime không giải mã được — mở ra có tiếng, không có hình.

Ba thay đổi:

1. **Xếp hạng lại luồng.** Trước đây chỉ sắp theo độ phân giải rồi bitrate, nên VP9 1080p luôn
   thắng H.264 1080p. Nay sắp theo độ phân giải → mức tương thích của codec → bitrate, và danh
   sách chia hai nhóm rõ ràng: "Mở được ở mọi nơi" và "Bitrate cao hơn — chỉ Chrome / VLC".
   Mặc định chọn luồng tốt nhất *trong nhóm chạy được ở mọi nơi*.
2. **Cảnh báo thẳng khi không có đường an toàn.** Nếu manifest không có H.264 nào, trang sẽ nói
   rõ điều đó và đưa hai lối thoát thay vì để người dùng tự đoán.
3. **Thêm chế độ chuyển mã sang H.264.** Bản ffmpeg đóng gói sẵn có `libx264`, nên có thể
   chuyển VP9/AV1 → H.264 giữ nguyên độ phân giải (`-preset superfast -crf 22`, audio giữ
   nguyên bằng `-c:a copy`). Chậm — 1080p vài phút thì mất tầm 5–20 phút — nên đây là lựa chọn
   người dùng bấm, không tự chạy.

Ghi chú: `Aborted()` cuối log không phải lỗi. Đó là emscripten in ra khi ffmpeg gọi `exit()`
sau khi chạy xong; nay được ghi lại thành "(ffmpeg thoát — bình thường)".

**Mẹo:** bản progressive HD của Facebook luôn là H.264 + AAC (đã kiểm chứng: `avc1`/`mp4a`),
nên nếu chỉ cần file mở được ngay ở mọi máy thì nút **HD** trong popup là nhanh nhất.
