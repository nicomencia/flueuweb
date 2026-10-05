// Audits Supabase Storage usage and (optionally) shrinks it.
//
// Usage (needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.cleanup):
//   node --env-file=.env.cleanup scripts/storage-cleanup.mjs              # dry run, report only
//   node --env-file=.env.cleanup scripts/storage-cleanup.mjs --apply      # delete orphans + recompress
//
// Every file that gets deleted or overwritten is first downloaded to ./storage-backup/.

import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 80;
const RECOMPRESS_ABOVE_BYTES = 400 * 1024;
const BACKUP_DIR = 'storage-backup';

// Every table/column that may hold a storage URL or filename.
const REFERENCE_SOURCES = {
  products: ['image_url', 'thumbnail_url', 'secondary_image_url'],
  collections: ['image_url'],
  collection_photos: ['image_url'],
  flowers: ['image_url'],
  accessory_types: ['image_url'],
  plastic_colors: ['image_url'],
};

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function listAllObjects(bucket, prefix = '') {
  const objects = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    for (const item of data) {
      const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) {
        objects.push(...(await listAllObjects(bucket, fullPath)));
      } else {
        objects.push({
          bucket,
          path: fullPath,
          size: item.metadata?.size ?? 0,
          mimetype: item.metadata?.mimetype ?? '',
        });
      }
    }
    if (data.length < 1000) break;
  }
  return objects;
}

async function loadReferences() {
  const refs = new Set();
  for (const [table, columns] of Object.entries(REFERENCE_SOURCES)) {
    const { data, error } = await supabase.from(table).select(columns.join(','));
    if (error) {
      // A column missing from the live schema must abort: guessing would risk deleting used files.
      throw new Error(`read ${table}: ${error.message}`);
    }
    for (const row of data) {
      for (const column of columns) {
        const value = row[column];
        if (!value) continue;
        refs.add(decodeURIComponent(String(value).split('?')[0]));
      }
    }
  }
  return refs;
}

function isReferenced(object, refs) {
  for (const ref of refs) {
    if (ref === object.path || ref.endsWith(`/${object.bucket}/${object.path}`)) return true;
  }
  return false;
}

async function backup(object) {
  const { data, error } = await supabase.storage.from(object.bucket).download(object.path);
  if (error) throw new Error(`download ${object.path}: ${error.message}`);
  const buffer = Buffer.from(await data.arrayBuffer());
  const target = path.join(BACKUP_DIR, object.bucket, object.path);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return buffer;
}

async function main() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;

  const objects = [];
  for (const bucket of buckets) objects.push(...(await listAllObjects(bucket.name)));
  const refs = await loadReferences();

  const total = objects.reduce((sum, o) => sum + o.size, 0);
  console.log(`\nTotal: ${objects.length} files, ${mb(total)}`);
  for (const bucket of buckets) {
    const inBucket = objects.filter((o) => o.bucket === bucket.name);
    console.log(`  ${bucket.name}: ${inBucket.length} files, ${mb(inBucket.reduce((s, o) => s + o.size, 0))}`);
  }

  const orphans = objects.filter((o) => !isReferenced(o, refs));
  const used = objects.filter((o) => isReferenced(o, refs));
  const oversized = used.filter(
    (o) => o.size > RECOMPRESS_ABOVE_BYTES && /^image\/(jpeg|png|webp)$/.test(o.mimetype)
  );

  console.log(`\nOrphaned (not referenced by any table): ${orphans.length} files, ${mb(orphans.reduce((s, o) => s + o.size, 0))}`);
  for (const o of orphans.slice(0, 30)) console.log(`  ${mb(o.size).padStart(9)}  ${o.bucket}/${o.path}`);
  if (orphans.length > 30) console.log(`  ... and ${orphans.length - 30} more`);

  console.log(`\nReferenced images above ${mb(RECOMPRESS_ABOVE_BYTES)}: ${oversized.length} files, ${mb(oversized.reduce((s, o) => s + o.size, 0))}`);
  console.log(`\nLargest 15 files:`);
  for (const o of [...objects].sort((a, b) => b.size - a.size).slice(0, 15)) {
    console.log(`  ${mb(o.size).padStart(9)}  ${o.bucket}/${o.path}${isReferenced(o, refs) ? '' : '  (orphan)'}`);
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to delete orphans and recompress oversized images.');
    return;
  }

  let saved = 0;

  for (const o of orphans) {
    await backup(o);
    const { error: removeError } = await supabase.storage.from(o.bucket).remove([o.path]);
    if (removeError) console.error(`  failed to delete ${o.path}: ${removeError.message}`);
    else saved += o.size;
  }
  console.log(`\nDeleted ${orphans.length} orphans (backups in ./${BACKUP_DIR})`);

  for (const o of oversized) {
    const original = await backup(o);
    const image = sharp(original).rotate();
    const { hasAlpha } = await image.metadata();
    if (hasAlpha) {
      console.log(`  skip ${o.path} (transparency)`);
      continue;
    }
    const compressed = await image
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    if (compressed.length >= o.size) continue;

    // Same path, so every URL in the database keeps working.
    const { error: uploadError } = await supabase.storage
      .from(o.bucket)
      .upload(o.path, compressed, { upsert: true, contentType: 'image/jpeg', cacheControl: '3600' });
    if (uploadError) {
      console.error(`  failed to replace ${o.path}: ${uploadError.message}`);
      continue;
    }
    saved += o.size - compressed.length;
    console.log(`  ${o.path}: ${mb(o.size)} -> ${mb(compressed.length)}`);
  }

  console.log(`\nSaved ${mb(saved)}. New estimated total: ${mb(total - saved)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
