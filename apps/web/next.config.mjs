/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@zapdesk/shared"],
  eslint: {
    // lint roda separadamente no monorepo
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    // Os packages do monorepo usam imports estilo NodeNext ("./x.js" para
    // arquivos .ts); o alias ensina o webpack a resolvê-los.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
