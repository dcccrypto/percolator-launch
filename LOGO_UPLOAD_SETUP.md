# Supabase Storage Setup for Logos and Token Metadata

This document describes how to set up Supabase Storage for market logo uploads and token metadata JSON files.

## Overview

The logo and metadata system stores:
1. **Market logos** - Used in markets list and trade pages (`market-logos/` folder)
2. **Token metadata JSON** - Metaplex-compliant metadata for wallet/explorer visibility (`token-metadata/` folder)

Both are stored in the same `logos` bucket and referenced via URLs.

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

Files will be stored with the following structure:
```
logos/
  ├── market-logos/
  │   ├── <slab_address_1>.png
  │   ├── <slab_address_2>.jpg
  │   └── <slab_address_3>.webp
  └── token-metadata/
      ├── <mint_address_1>.json
      ├── <mint_address_2>.json
      └── <mint_address_3>.json
```

- **market-logos/** - Logo images for markets (PNG, JPG, GIF, WEBP, SVG)
- **token-metadata/** - Metaplex metadata JSON files for tokens

### 4. Environment Variables

No additional environment variables are needed. The API uses the existing Supabase configuration:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side only)

## Usage

### Market Logo Upload

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

---

## Token Metadata System

### Overview

The token metadata system creates Metaplex-compliant JSON files that make token logos visible in wallets (Phantom, Solflare) and explorers (Solscan, Solana Explorer).

### Metadata JSON Format

Standard Metaplex format:
```json
{
  "name": "My Token",
  "symbol": "MTK",
  "description": "A description of my token",
  "image": "https://[project].supabase.co/storage/v1/object/public/logos/market-logos/[address].png",
  "external_url": "https://myproject.com",
  "properties": {
    "files": [
      {
        "uri": "https://[project].supabase.co/storage/v1/object/public/logos/market-logos/[address].png",
        "type": "image/png"
      }
    ],
    "category": "image"
  }
}
```

### API Endpoints

#### POST /api/tokens/[mint]/metadata
Create or update token metadata JSON and optionally update on-chain metadata account.

**Request:**
```json
{
  "name": "My Token",
  "symbol": "MTK",
  "description": "Optional description",
  "image_url": "https://...",
  "external_url": "https://...",
  "update_authority_keypair": "[1,2,3,...]" // Optional, for on-chain update
}
```

**Response:**
```json
{
  "message": "Metadata uploaded successfully",
  "metadata_uri": "https://[project].supabase.co/storage/v1/object/public/logos/token-metadata/[mint].json",
  "metadata": { ... },
  "on_chain_update": {
    "signature": "...",
    "metadata_address": "..."
  }
}
```

#### GET /api/tokens/[mint]/metadata
Retrieve existing metadata JSON for a token.

### Usage Flow

1. **Create Token** - Use `/devnet-mint` to create a token
2. **Navigate to Update Page** - Go to `/update-token-metadata?mint=[address]`
3. **Upload Logo** - Drag & drop or click to upload token logo
4. **Fill Metadata** - Add description and external URL (optional)
5. **Provide Update Authority** - Paste update authority keypair for on-chain update (optional)
6. **Submit** - Click "Update Token Metadata"
7. **Verify** - Check Phantom wallet or Solana Explorer to see the logo!

### On-Chain Updates

To update the on-chain metadata account, you need:

1. **Update Authority Keypair** - The keypair that has authority to update the metadata
2. **Sufficient SOL** - For transaction fees (~0.000005 SOL)

The system uses `updateMetadataAccountV2` instruction to update the `uri` field in the metadata account, which points to the JSON file in Supabase Storage.

### Storage Paths

- Metadata JSON: `logos/token-metadata/[mint_address].json`
- Logo Image: `logos/market-logos/[mint_address].png` (or jpg, gif, etc.)

### Security Notes

1. **Update Authority** - Keypair is only used client-side, never sent to server as plain text
2. **JSON Validation** - All metadata is validated before upload
3. **Public Access** - Metadata JSON must be publicly readable for wallets/explorers
4. **Authentication** - API key required for creating/updating metadata

### Wallet Integration

Once metadata is updated:

- **Phantom Wallet** - Displays logo automatically when viewing token
- **Solana Explorer** - Shows logo on token page
- **Solscan** - Displays logo in token details
- **Jupiter** - May show logo in swap interface (if indexed)

### Troubleshooting

#### Logo not showing in wallet
1. Wait 5-10 minutes for caches to update
2. Verify metadata URI is set on-chain: `solana account [metadata_pda]`
3. Check that JSON file is publicly accessible
4. Ensure image URL in JSON is valid and public

#### On-chain update failed
1. Verify you provided the correct update authority keypair
2. Check wallet has sufficient SOL for transaction
3. Ensure metadata account exists (created during token creation)
4. Check RPC connection is working

#### Metadata JSON not found
1. Confirm file was uploaded to `token-metadata/[mint].json`
2. Check Supabase Storage bucket has public read access
3. Verify URL format is correct

### Example: Complete Flow

```bash
# 1. Create token on devnet
# 2. Upload logo via /update-token-metadata
# 3. The system:
#    - Uploads logo to: logos/market-logos/[mint].png
#    - Creates JSON: logos/token-metadata/[mint].json with:
{
  "name": "Test Token",
  "symbol": "TEST",
  "image": "https://[project].supabase.co/.../logos/market-logos/[mint].png"
}
#    - Updates on-chain metadata account with JSON URI
# 4. Verify in Phantom:
#    - Open wallet
#    - View token
#    - Logo should appear!
```

### Best Practices

1. **Image Size** - Use 512x512px for best results
2. **File Format** - PNG with transparency preferred
3. **File Size** - Keep under 200KB for fast loading
4. **Description** - Keep concise, under 200 characters
5. **External URL** - Link to project website or docs
6. **Update Early** - Update metadata soon after token creation for best indexing

