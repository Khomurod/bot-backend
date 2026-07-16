'use strict';

const { query } = require('./pool');

async function createTrailerMedia(data, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `INSERT INTO trailer_media
      (media_type,trailer_id,rental_id,inspection_id,invoice_id,payment_id,bucket,object_path,
       preview_object_path,original_filename,mime_type,original_size_bytes,compressed_size_bytes,
       checksum_sha256,uploaded_by_admin_id,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [data.mediaType,data.trailerId || null,data.rentalId || null,data.inspectionId || null,
     data.invoiceId || null,data.paymentId || null,data.bucket,data.objectPath,data.previewObjectPath || null,
     data.originalFilename,data.mimeType,data.originalSize,data.previewSize || null,data.checksum,
     data.uploadedByAdminId || null,data.notes || null],
  );
  return res.rows[0];
}

async function getTrailerMedia(id) {
  const res = await query('SELECT * FROM trailer_media WHERE id=$1', [id]);
  return res.rows[0] || null;
}

async function attachMediaToPayment(mediaId, paymentId, client) {
  const res = await client.query('UPDATE trailer_media SET payment_id=$2 WHERE id=$1 RETURNING *', [mediaId,paymentId]);
  return res.rows[0] || null;
}

module.exports = { createTrailerMedia, getTrailerMedia, attachMediaToPayment };
