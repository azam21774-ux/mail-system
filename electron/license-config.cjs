module.exports = {
  // Keep the environment override for local/deployment-specific testing.
  licenseServerUrl:
    process.env.LICENSE_SERVER_URL ||
    'https://ougnvhvbejiibxtdrdld.supabase.co/functions/v1/license-api',
}