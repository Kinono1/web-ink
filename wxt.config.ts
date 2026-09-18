import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // WXT otherwise infers required host access from runtime content-script matches.
      // Access is optional and requested by the onboarding button instead.
      delete manifest.host_permissions;
    },
  },
  manifest: {
    name: 'Web Ink',
    // Public identity only; no signing/private key is stored. Keeps unpacked updates on one extension ID.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4n6P1D4S+MiEEKzR8tSoDiasN7sKcPay3e/9CfIzAkTB/VnAzEO183KJQ64Nn3nrmwzJ7du6Bk74OfOZZQhsVxZWI/lxaU6e+z5x/htBESAsdqsyqLGZ5VL42BSh82UkgD6BDI1AH4amaIJbELu5C11cwYprXG8vHh5O/21Bo6BGn2rP4e621nQ0AgW+UALOOrIEdids1CglDQDYvJo8xGfP25IY2yGZgmu4UCUWtzW27nJkLMS4wJm8VVzDN79GCKO61WaZiegYnUgWRhipKbjtO9eJP4kPF9CIMRqVEeGIWcpib2tGdwEzpHTNSHCpcYsEJ0Iw35C8NgTR1siZZwIDAQAB',
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    description: 'Private text highlights and image annotations. 本地网页文字与图片标注。',
    minimum_chrome_version: '120',
    permissions: ['storage', 'scripting', 'sidePanel'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: 'Web Ink' },
    side_panel: { default_path: 'sidepanel.html' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
  },
});
