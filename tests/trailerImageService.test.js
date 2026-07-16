'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const sharp=require('sharp');
const{processTrailerUpload}=require('../services/trailerImageService');
async function temp(name,bytes){const file=path.join(os.tmpdir(),`trailer-test-${process.pid}-${Date.now()}-${name}`);await fs.writeFile(file,bytes);return file}
test('condition image is decoded, oriented, bounded, and previewed',async(t)=>{
  const file=await temp('condition.jpg',await sharp({create:{width:2400,height:1200,channels:3,background:'#336699'}}).jpeg().toBuffer());t.after(()=>fs.unlink(file).catch(()=>{}));
  const result=await processTrailerUpload({path:file,originalname:'../unsafe photo.jpg',mimetype:'image/jpeg',size:(await fs.stat(file)).size});
  const metadata=await sharp(result.preview).metadata();assert.ok(metadata.width<=2000);assert.equal(result.mimeType,'image/jpeg');assert.match(result.originalFilename,/unsafe-photo\.jpg/);assert.equal(result.checksum.length,64);
});
test('fake images and malformed PDFs are rejected by content',async(t)=>{
  const fake=await temp('fake.jpg',Buffer.from('not an image'));t.after(()=>fs.unlink(fake).catch(()=>{}));
  await assert.rejects(()=>processTrailerUpload({path:fake,originalname:'fake.jpg',mimetype:'image/jpeg',size:12}),/decode|image/i);
  const pdf=await temp('fake.pdf',Buffer.from('not a pdf'));t.after(()=>fs.unlink(pdf).catch(()=>{}));
  await assert.rejects(()=>processTrailerUpload({path:pdf,originalname:'fake.pdf',mimetype:'application/pdf',size:9}),/PDF/i);
});
