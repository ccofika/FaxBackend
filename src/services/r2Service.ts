import crypto from 'crypto';

class R2Service {
  private getR2Headers(method: string, path: string, contentType?: string): Record<string, string> {
    const credentials = {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    };

    const headers: any = {};
    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    const requestOptions = {
      method,
      host: `${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      path: `/${path}`,
      headers,
      service: 's3',
      region: 'auto',
    };

    const signedRequest = require('aws4').sign(requestOptions, credentials);
    return signedRequest.headers;
  }

  async upload(r2Key: string, buffer: Buffer, contentType: string = 'application/octet-stream'): Promise<void> {
    try {
      const uploadUrl = `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`;
      
      const headers = this.getR2Headers('PUT', r2Key, contentType);

      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers,
        body: buffer,
      });

      if (!response.ok) {
        throw new Error(`Failed to upload to R2: ${response.status} ${response.statusText}`);
      }

      console.log(`Successfully uploaded to R2: ${r2Key}`);
    } catch (error) {
      console.error('Error uploading to R2:', error);
      throw error;
    }
  }

  async download(r2Key: string): Promise<Buffer> {
    try {
      const downloadUrl = `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`;
      
      const headers = this.getR2Headers('GET', r2Key);

      const response = await fetch(downloadUrl, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        throw new Error(`Failed to download from R2: ${response.status} ${response.statusText}`);
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      console.error('Error downloading from R2:', error);
      throw error;
    }
  }

  async delete(r2Key: string): Promise<void> {
    try {
      const deleteUrl = `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`;
      
      const headers = this.getR2Headers('DELETE', r2Key);

      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers,
      });

      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete from R2: ${response.status} ${response.statusText}`);
      }

      console.log(`Successfully deleted from R2: ${r2Key}`);
    } catch (error) {
      console.error('Error deleting from R2:', error);
      throw error;
    }
  }

  async exists(r2Key: string): Promise<boolean> {
    try {
      const headUrl = `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`;
      
      const headers = this.getR2Headers('HEAD', r2Key);

      const response = await fetch(headUrl, {
        method: 'HEAD',
        headers,
      });

      return response.ok;
    } catch (error) {
      console.error('Error checking R2 file existence:', error);
      return false;
    }
  }

  generateKey(prefix: string, filename?: string): string {
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    
    if (filename) {
      const extension = filename.split('.').pop() || '';
      return `${prefix}/${timestamp}-${randomString}.${extension}`;
    }
    
    return `${prefix}/${timestamp}-${randomString}`;
  }
}

export default new R2Service();