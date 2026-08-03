export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  x402FacilitatorUrl: process.env.X402_FACILITATOR_URL || '',
  algorandNodeUrl: process.env.ALGORAND_NODE_URL || 'https://mainnet-api.algonode.cloud',
  qwenApiKey: process.env.QWEN_API_KEY || '',
  googleCloudVisionApiKey: process.env.GOOGLE_CLOUD_VISION_API_KEY || '',
  logLevel: process.env.LOG_LEVEL || 'info',
};
