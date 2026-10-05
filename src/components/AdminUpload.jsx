import { useState } from 'react';
import { supabase } from '../lib/supabase';
import './AdminUpload.css';

export default function AdminUpload() {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');

  const resizeImage = (file, maxSize, quality) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > maxSize) {
              height *= maxSize / width;
              width = maxSize;
            }
          } else {
            if (height > maxSize) {
              width *= maxSize / height;
              height = maxSize;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob((blob) => {
            resolve(blob);
          }, 'image/jpeg', quality);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const uploadImage = async (event) => {
    try {
      setUploading(true);
      setMessage('');

      const files = event.target.files;
      if (!files || files.length === 0) {
        throw new Error('You must select an image to upload.');
      }

      const uploadPromises = Array.from(files).map(async (file) => {
        const fileName = file.name;
        const filePath = `${fileName}`;
        const thumbnailPath = fileName.replace(/(\.[^.]+)$/, '_thumbnail$1');

        const fullBlob = await resizeImage(file, 1600, 0.8);
        const { error: uploadError } = await supabase.storage
          .from('product-images')
          .upload(filePath, fullBlob, {
            cacheControl: '3600',
            upsert: true,
            contentType: 'image/jpeg'
          });

        if (uploadError) {
          throw uploadError;
        }

        const thumbnailBlob = await resizeImage(file, 800, 0.85);
        const { error: thumbnailError } = await supabase.storage
          .from('product-images')
          .upload(thumbnailPath, thumbnailBlob, {
            cacheControl: '3600',
            upsert: true,
            contentType: 'image/jpeg'
          });

        if (thumbnailError) {
          console.warn('Thumbnail upload failed:', thumbnailError);
        }

        return filePath;
      });

      await Promise.all(uploadPromises);

      setMessage(`Successfully uploaded ${files.length} image(s) with thumbnails!`);
      event.target.value = '';
    } catch (error) {
      setMessage(error.message);
    } finally {
      setUploading(false);
    }
  };

  const getPublicUrl = async () => {
    const fileName = prompt('Enter the exact filename (e.g., ELJARDIN0A04.jpg):');
    if (!fileName) return;

    const { data } = supabase.storage
      .from('product-images')
      .getPublicUrl(fileName);

    const thumbnailFileName = fileName.replace(/(\.[^.]+)$/, '_thumbnail$1');
    const { data: thumbData } = supabase.storage
      .from('product-images')
      .getPublicUrl(thumbnailFileName);

    setMessage(`Full URL: ${data.publicUrl}\n\nThumbnail URL: ${thumbData.publicUrl}`);
  };

  return (
    <div className="admin-upload">
      <div className="admin-upload-card">
        <h2>Upload Product Images</h2>
        <p className="admin-upload-description">
          Upload your product images to Supabase Storage. You can select multiple files at once.
        </p>

        <div className="admin-upload-section">
          <label htmlFor="image-upload" className="admin-upload-label">
            {uploading ? 'Uploading...' : 'Choose Images'}
          </label>
          <input
            id="image-upload"
            type="file"
            accept="image/*"
            multiple
            onChange={uploadImage}
            disabled={uploading}
            className="admin-upload-input"
          />
        </div>

        {message && (
          <div className={`admin-upload-message ${message.includes('Success') ? 'success' : 'error'}`}>
            {message}
          </div>
        )}

        <div className="admin-upload-helper">
          <button onClick={getPublicUrl} className="admin-upload-button">
            Get Image URL
          </button>
          <p className="admin-upload-hint">
            After uploading, use this to get the public URL for a specific image
          </p>
        </div>

        <div className="admin-upload-instructions">
          <h3>How to use:</h3>
          <ol>
            <li>Click "Choose Images" and select one or multiple product photos</li>
            <li>Wait for the upload to complete</li>
            <li>Both full-size images and optimized thumbnails will be stored</li>
            <li>Use "Get Image URL" to get both URLs for any uploaded image</li>
            <li>Use the thumbnail URL for faster grid loading and full URL for lightbox</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
