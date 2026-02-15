# Supabase Storage Setup for Market Logos

This document describes how to set up Supabase Storage for market logo uploads.

## Overview

The logo upload feature stores market logos in Supabase Storage and references them via the `logo_url` column in the `markets` table.

## Setup Steps

### 1. Create Storage Bucket

1. Go to your Supabase project dashboard
2. Navigate to **Storage** in the left sidebar
3. Click **Create a new bucket**
4. Configure the bucket:
   - **Name**: `logos`
   - **Public bucket**: ✅ Yes (logos need to be publicly accessible)
   - **File size limit**: 5MB (recommended)
   - **Allowed MIME types**: `image/png, image/jpeg, image/jpg, image/gif, image/webp, image/svg+xml`

### 2. Set Storage Policies

The bucket should allow:
- **Public read access** (anyone can view logos)
- **Authenticated write access** (only authenticated users can upload)

#### SQL Policy Commands

```sql
-- Allow public read access to all files in the logos bucket
CREATE POLICY "Public Access"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'logos');

-- Allow authenticated users to upload files
CREATE POLICY "Authenticated users can upload logos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'logos');

-- Allow authenticated users to update their own uploads
CREATE POLICY "Authenticated users can update logos"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'logos')
WITH CHECK (bucket_id = 'logos');

-- Allow authenticated users to delete logos
CREATE POLICY "Authenticated users can delete logos"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'logos');
```

### 3. Configure Folder Structure

Logos will be stored with the following structure:
```
logos/
  └── market-logos/
      ├── <slab_address_1>.png
      ├── <slab_address_2>.jpg
      └── <slab_address_3>.webp
```

Each logo file is named using the market's slab address for easy identification.

### 4. Environment Variables

No additional environment variables are needed. The API uses the existing Supabase configuration:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side only)

## Usage

### Uploading a Logo

#### Option 1: Via Upload Page
1. Navigate to `/upload-logo`
2. Enter the market's slab address
3. Click "Load Market"
4. Drag & drop or click to select a logo file
5. Logo uploads automatically

#### Option 2: Via API
```bash
curl -X POST https://your-domain.com/api/markets/[slab]/logo/upload \
  -H "x-api-key: YOUR_API_KEY" \
  -F "logo=@path/to/logo.png"
```

#### Option 3: Via External URL
```bash
curl -X PUT https://your-domain.com/api/markets/[slab]/logo \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"logo_url": "https://example.com/logo.png"}'
```

### File Requirements

- **Formats**: PNG, JPG, GIF, WEBP, SVG
- **Max size**: 5MB
- **Recommended dimensions**: 512x512px (square)
- **Naming**: Automatically set to `<slab_address>.<ext>`

## API Endpoints

### POST /api/markets/[slab]/logo/upload
Upload a logo file for a market.

**Request:**
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body: Form data with `logo` field containing the file
- Headers: `x-api-key: YOUR_API_KEY`

**Response:**
```json
{
  "message": "Logo uploaded successfully",
  "logo_url": "https://[project-id].supabase.co/storage/v1/object/public/logos/market-logos/[slab].png",
  "market": { ... }
}
```

### PUT /api/markets/[slab]/logo
Update logo URL for a market (for external URLs).

**Request:**
```json
{
  "logo_url": "https://example.com/logo.png"
}
```

**Response:**
```json
{
  "market": { ... }
}
```

### GET /api/markets/[slab]/logo
Get current logo URL for a market.

**Response:**
```json
{
  "logo_url": "https://[project-id].supabase.co/storage/v1/object/public/logos/market-logos/[slab].png"
}
```

## Integration Points

### Frontend Components

#### MarketLogo Component
```tsx
import { MarketLogo } from "@/components/market/MarketLogo";

<MarketLogo
  logoUrl={market.logo_url}
  symbol={market.symbol}
  size="md" // xs, sm, md, lg, xl
/>
```

#### LogoUpload Component
```tsx
import { LogoUpload } from "@/components/market/LogoUpload";

<LogoUpload
  slabAddress={market.slab_address}
  currentLogoUrl={market.logo_url}
  onSuccess={(logoUrl) => console.log("Uploaded:", logoUrl)}
  size="lg"
/>
```

### Where Logos Are Displayed

1. **Markets List** (`/markets`): Logo next to market name
2. **Trade Page** (`/trade/[slab]`): Logo in header (mobile & desktop)
3. **Upload Page** (`/upload-logo`): Preview and upload interface

### Fallback Behavior

When no logo is available:
- Display the first letter of the token symbol
- Use accent color gradient background
- Maintain consistent sizing

## Troubleshooting

### Logo not displaying
1. Check that the `logos` bucket exists
2. Verify public read access is enabled
3. Confirm the logo_url in database is valid
4. Check browser console for CORS errors

### Upload fails with 401/403
1. Verify `x-api-key` header is set correctly
2. Check that authentication is configured
3. Ensure storage policies allow uploads

### Image broken/404
1. Confirm file was uploaded to Supabase Storage
2. Check the file path: `market-logos/[slab].[ext]`
3. Verify public URL structure is correct

## Migration

The database migration adds the `logo_url` column:
```sql
ALTER TABLE markets 
ADD COLUMN IF NOT EXISTS logo_url TEXT;
```

Apply with:
```bash
# Via Supabase CLI
supabase db push

# Or manually in Supabase dashboard SQL editor
```

## Security Considerations

1. **File validation**: Only allowed MIME types can be uploaded
2. **Size limits**: Max 5MB to prevent abuse
3. **API authentication**: Requires API key for uploads
4. **Public access**: Logos are publicly accessible (as intended)
5. **Overwrite protection**: Uses `upsert: true` to replace existing logos

## Future Enhancements

Potential improvements:
- Image optimization/resizing on upload
- CDN integration for faster loading
- Support for animated GIFs/video
- Logo moderation/approval workflow
- Batch upload for multiple markets
- Integration with token metadata (Metaplex)
