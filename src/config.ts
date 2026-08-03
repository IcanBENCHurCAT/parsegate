export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  // x402 payment config
  x402FacilitatorUrl: process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator',
  algorandNodeUrl: process.env.ALGORAND_NODE_URL || 'https://testnet-api.algonode.cloud',
  // Algorand address for receiving USDC payments
  avmPayToAddress: process.env.AVM_PAY_TO_ADDRESS || '',
  // Whether to require real x402 payments (false for dev/test)
  x402TestMode: process.env.X402_TEST_MODE === 'true',
  // API keys for processing backends
  qwenApiKey: process.env.QWEN_API_KEY || '',
  googleCloudVisionApiKey: process.env.GOOGLE_CLOUD_VISION_API_KEY || '',
  logLevel: process.env.LOG_LEVEL || 'info',
};
