import React, { useState, useEffect, useRef } from "react";
import * as api from "../../api";

/**
 * Attach photos, videos and documents to a message, with the browser-side
 * downscale that keeps large phone photos from timing out the upload.
 *
 * Split out of admin/src/components/Shared.jsx.
 */

// Telegram re-compresses every photo to at most ~2560px JPEG on its side, so
// uploading a multi-MB original gains nothing — it just makes the upload slow
// (browser → server → Telegram, full size both legs) and prone to timeouts on
// the small production instance. Downscale in the browser first: identical
// final quality in Telegram, ~10-50x less data to move.
const PHOTO_COMPRESS_THRESHOLD_BYTES = 1.5 * 1024 * 1024;
const PHOTO_MAX_DIMENSION = 2560;
const PHOTO_JPEG_QUALITY = 0.85;

async function compressPhotoForTelegram(file) {
  try {
    if (!file.type.startsWith("image/")) return file;
    if (file.size <= PHOTO_COMPRESS_THRESHOLD_BYTES) return file;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY));
    // Only swap in the compressed copy when it actually helps.
    if (!blob || blob.size >= file.size) return file;
    const baseName = (file.name || "photo").replace(/\.[^.]+$/, "");
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  } catch (err) {
    // Decode failure (odd format, huge image, etc.) — fall back to the original
    // and let the server-side size check handle it.
    return file;
  }
}

export const MediaUploader = React.memo(function MediaUploader({ onAdd, onRemove, items }) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  const itemsRef = useRef(items);
  const MAX_VIDEO_UPLOAD_MB = 20;
  // Telegram rejects photos larger than 10MB via sendPhoto, so stop them here
  // rather than uploading multiple MB only to have Telegram reject them.
  const MAX_PHOTO_UPLOAD_MB = 10;

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    return () => {
      (itemsRef.current || []).forEach((item) => {
        if (item && item.preview_object_url && item.url) {
          URL.revokeObjectURL(item.url);
        }
      });
    };
  }, []);

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    if (items.length + files.length > 10) {
      alert("Maximum 10 media items allowed per message.");
      return;
    }

    setUploading(true);
    const createdUrls = [];
    try {
      const results = [];
      for (const rawFile of files) {
        const type = rawFile.type.startsWith("video/") ? "video" : "photo";
        if (type === "video" && rawFile.size > MAX_VIDEO_UPLOAD_MB * 1024 * 1024) {
          throw new Error(`Video ${rawFile.name} exceeds ${MAX_VIDEO_UPLOAD_MB}MB limit for bots.`);
        }
        // Downscale large photos in the browser before uploading — Telegram
        // recompresses photos anyway, so this is lossless in practice and makes
        // the upload fast instead of timing out.
        const file = type === "photo" ? await compressPhotoForTelegram(rawFile) : rawFile;
        if (type === "photo" && file.size > MAX_PHOTO_UPLOAD_MB * 1024 * 1024) {
          const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
          throw new Error(
            `Photo ${rawFile.name} is ${sizeMb}MB even after compression — Telegram allows photos up to `
            + `${MAX_PHOTO_UPLOAD_MB}MB. Please resize the image, or send it as an MP4 video.`
          );
        }
        const data = await api.uploadMedia(file);
        const normalizedType = data.type || data.media_type || type;
        const hasRemoteUrl = Boolean(data.url);
        const uploadedUrl = hasRemoteUrl ? data.url : URL.createObjectURL(file);
        if (!hasRemoteUrl) createdUrls.push(uploadedUrl);
        results.push({
          file_id: data.file_id,
          type: normalizedType,
          url: uploadedUrl,
          preview_object_url: !hasRemoteUrl,
        });
      }
      onAdd(results);
    } catch (err) {
      createdUrls.forEach((u) => URL.revokeObjectURL(u));
      alert("Upload failed: " + err.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemove = (idx) => {
    const item = items[idx];
    if (item && item.preview_object_url && item.url) {
      URL.revokeObjectURL(item.url);
    }
    onRemove(idx);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {items.map((m, idx) => (
          <div key={idx} style={{
            position: "relative",
            width: 80,
            height: 80,
            borderRadius: 8,
            overflow: "hidden",
            background: "rgba(255,255,255,0.1)",
            border: "1px solid rgba(255,255,255,0.2)",
          }}>
            {(m.type || m.media_type) === "photo" ? (
              <img src={m.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" />
            ) : (
              <video src={m.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            )}
            <div
              style={{
                position: "absolute",
                top: 4,
                right: 4,
                background: "rgba(0,0,0,0.6)",
                color: "white",
                borderRadius: "50%",
                width: 20,
                height: 20,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                cursor: "pointer",
                fontWeight: "bold",
              }}
              onClick={() => handleRemove(idx)}
              title="Remove"
            >
              x
            </div>
            {(m.type === "video" || m.media_type === "video") && (
              <div style={{
                position: "absolute",
                bottom: 4,
                left: 4,
                background: "rgba(0,0,0,0.6)",
                color: "white",
                borderRadius: 4,
                padding: "2px 4px",
                fontSize: 10,
              }}>
                VID
              </div>
            )}
          </div>
        ))}
        {items.length < 10 && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: 80, height: 80, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 4, padding: 0 }}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <span style={{ fontSize: 24 }}>{uploading ? "..." : "+"}</span>
            <span style={{ fontSize: 10 }}>{items.length}/10</span>
          </button>
        )}
      </div>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleUpload}
        accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
        style={{ display: "none" }}
        multiple
      />
    </div>
  );
});

export function MediaPositionSelector({ name, position, onChange }) {
  return (
    <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 14 }}>
        <input
          type="radio"
          name={name}
          value="above"
          checked={position === "above"}
          onChange={() => onChange("above")}
        />
        Above text
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 14 }}>
        <input
          type="radio"
          name={name}
          value="below"
          checked={position === "below"}
          onChange={() => onChange("below")}
        />
        Below text
      </label>
    </div>
  );
}
