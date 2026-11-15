# Contributing

Start with an issue describing the problem or proposed behavior. For fixes, include reproduction steps and the relevant browser, plugin version, and transport.

Use Node.js 24. Follow the README for local setup and run the server tests, client tests, lint, and production build before opening a pull request. Plugin changes also require the .NET tests and Go sender checks described in the plugin guide. Keep secrets, generated builds, and personal media out of commits.

Preserve compatibility with the published plugin GUID and catalog URL. Never replace published release bytes. Update plugin assembly and metadata versions together when preparing a new release.

The web application and backend are All Rights Reserved. The plugin has a separate GPL-3.0-or-later license. Review the applicable license before contributing; contributions do not change that scope.
