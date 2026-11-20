import type {CapacitorConfig} from '@capacitor/cli';

const config:CapacitorConfig={
  appId:'de.example.securityops',
  appName:'SecurityOps',
  webDir:'frontend/dist',
  server:{androidScheme:'https'},
};

export default config;
