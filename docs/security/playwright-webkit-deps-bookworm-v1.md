# Playwright WebKit Deps Profile: `bookworm-pinned-v1`

This profile defines the pinned package allowlist used when building
`Dockerfile.gateway` with:

- `OPENCLAW_INSTALL_PLAYWRIGHT_WEBKIT=1`
- `OPENCLAW_PLAYWRIGHT_WEBKIT_DEPS_PROFILE=bookworm-pinned-v1`

## Scope

- Target OS family: Debian 12 (Bookworm) gateway images.
- Purpose: enable Playwright WebKit engine and iPhone/WebKit emulation lanes.
- Runtime model: build-time install only, no runtime `apt` or `--with-deps`.

## Package Allowlist

These packages are installed with `--no-install-recommends`:

```text
xvfb
fonts-noto-color-emoji
fonts-unifont
libfontconfig1
libfreetype6
xfonts-scalable
fonts-liberation
fonts-ipafont-gothic
fonts-wqy-zenhei
fonts-tlwg-loma-otf
fonts-freefont-ttf
libsoup-3.0-0
gstreamer1.0-libav
gstreamer1.0-plugins-bad
gstreamer1.0-plugins-base
gstreamer1.0-plugins-good
libcairo2
libdbus-1-3
libdrm2
libegl1
libenchant-2-2
libepoxy0
libevdev2
libgbm1
libgdk-pixbuf-2.0-0
libgles2
libglib2.0-0
libglx0
libgstreamer-gl1.0-0
libgstreamer-plugins-base1.0-0
libgstreamer1.0-0
libgtk-4-1
libgudev-1.0-0
libharfbuzz-icu0
libharfbuzz0b
libhyphen0
libicu72
libjpeg62-turbo
liblcms2-2
libmanette-0.2-0
libnotify4
libopengl0
libopenjp2-7
libopus0
libpango-1.0-0
libpng16-16
libproxy1v5
libsecret-1-0
libwayland-client0
libwayland-egl1
libwayland-server0
libwebp7
libwebpdemux2
libwoff1
libx11-6
libxkbcommon0
libxml2
libxslt1.1
libatomic1
libevent-2.1-7
libavif15
```

## Source and Maintenance

- Derived from Playwright's Debian 12 native dependency map in
  `playwright-core/lib/server/registry/nativeDeps.js` (`debian12-x64` tools + webkit),
  then constrained to a fixed allowlist in Docker build code.
- Any package add/remove requires:
  1. updating this file,
  2. updating `Dockerfile.gateway`,
  3. regenerating/revalidating affected images.

## Security Notes

- This profile is opt-in per agent service via compose build args.
- Non-WebKit agents should not enable this profile.
- Browser binaries are installed under `/home/node/.cache/ms-playwright` and
  ownership is reassigned to `node:node` for non-root runtime.
