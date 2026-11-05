declare module 'ssh2/lib/protocol/constants.js' {
  const constants: {
    SUPPORTED_KEX: string[];
    SUPPORTED_CIPHER: string[];
    SUPPORTED_SERVER_HOST_KEY: string[];
    SUPPORTED_MAC: string[];
  };
  export default constants;
}
