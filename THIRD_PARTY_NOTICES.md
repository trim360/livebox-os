# Third-party licenses and provenance

The root [MIT license](LICENSE) covers original Livebox OS code only. It does **not** relicense dependencies, referenced projects, vendor firmware, trademarks or independently licensed data. No third-party license is replaced with MIT.

## Reference projects

### LiveboxMonitor

[LiveboxMonitor](https://github.com/p-dor/LiveboxMonitor), copyright Pierre Dor, is MIT licensed. The reviewed revision is `d3a5d546b44b7a35bf63c6d1c89c539908ff9f80`. Its full notice is retained in [licenses/LiveboxMonitor-MIT.txt](licenses/LiveboxMonitor-MIT.txt).

The project informed service names, response shapes and authentication conventions. Livebox OS does not bundle LiveboxMonitor or its PyQt application. The notice is kept conservatively to preserve attribution for the protocol study.

### TP-Link-Archer-C6U

[TP-Link-Archer-C6U](https://github.com/AlexandrErohin/TP-Link-Archer-C6U), reviewed at `31ec8840c7d62f51794e6ee5ad4d8a4e5a053799`, is GPLv3. Its source/package is **not included**, linked or installed by Livebox OS. The AX58 connector is an independent asynchronous implementation informed by the firmware actually observed on an authorized device. No firmware JavaScript bundle is distributed.

A source comparison found no exact implementation sequence meeting the review threshold of five non-comment lines and 300 characters between the application and either reference project. That check supports provenance review but is not a proof about all possible derivation. Future copying from GPL code requires a new license review; do not relabel copied GPL code as MIT.

## Dependencies

The resolved Windows and Linux validation inventory, with package versions, declared licenses, upstream sources and notice paths, is [docs/dependency-licenses.json](docs/dependency-licenses.json). The `licenses/` directory retains package license/notice texts, including copyright notices. Base-image packages retain their packaged notices and may differ by platform.

| Components | License / obligation |
|---|---|
| React, React DOM, Tailwind CSS, Vite, TypeScript, FastAPI, Argon2, smbprotocol and many supporting packages | Mostly MIT; preserve their individual copyright/permission notices |
| Lucide React | ISC, with Feather portions credited under MIT in its distributed notice |
| Starlette, Uvicorn, HTTPX and supporting packages | BSD variants; retain copyright, conditions and disclaimers |
| cryptography | Apache-2.0 OR BSD-3-Clause, including its distributed notices; bundled OpenSSL components retain their own terms |
| OpenTelemetry API and some build dependencies | Apache-2.0; retain licenses and applicable NOTICE files; no telemetry exporter is configured by this application |
| certifi certificate bundle | MPL-2.0; unmodified, separately licensed. Corresponding source is available from its versioned [PyPI release](https://pypi.org/project/certifi/2026.10.23/#files) and upstream |
| lightningcss and its platform binary (build tools) | MPL-2.0; unmodified. Source: [lightningcss](https://github.com/parcel-bundler/lightningcss), with the exact package version in the inventory |
| caniuse-lite (build-time browser data) | CC-BY-4.0; retain its attribution/license. Source: [caniuse-lite](https://github.com/browserslist/caniuse-lite), derived from [Can I use](https://caniuse.com/) data |
| Python typing extensions | PSF-2.0; retain the distributed license |
| Pillow 13.0.0 and bundled image codecs | MIT-CMU and the codec notices in [licenses/pillow/LICENSE](licenses/pillow/LICENSE); used to validate, resize and strip metadata from account avatars |

MPL applies at the covered-file level; these separately installed, unmodified components are not being relicensed. Build tools are not copied into the final static frontend image. Where redistributed components require corresponding source, use the versioned upstream source identified in the inventory; no modifications to those dependencies are included here. Runtime wheels retain their license metadata inside site-packages. Dockerfiles also copy these project notices into their images.

The MIT license allows commercial use as well as free use; “free project” does not remove dependencies' attribution or source-availability obligations.

## Hardware photographs

The original, unmodified photographs in `frontend/public/hardware/` are separately licensed **CC BY-SA 4.0**, not MIT. The in-app photo credit links to [the bundled attribution page](frontend/public/hardware/credits.html), with authors, sources and the license URI. No Orange endorsement or unrestricted Orange photo permission is claimed.

- Livebox 4: Poudou99, [Livebox-Orange-V4 - IMG 6465.jpg](https://commons.wikimedia.org/wiki/File:Livebox-Orange-V4_-_IMG_6465.jpg).
- Livebox 5: Théodu57, [Livebox 5.png](https://commons.wikimedia.org/wiki/File:Livebox_5.png), 2024-07-29.
- Livebox 6: Poudou99, [Livebox 6 - Devant - IMG 0057.jpg](https://commons.wikimedia.org/wiki/File:Livebox_6_-_Devant_-_IMG_0057.jpg).

License: [Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Source checksums are pinned by `scripts/check_release.py`. The verified ProductClass naming comes from the credited LiveboxMonitor reference; conflicting/unknown models and models without a licensed photograph use a neutral pictogram. The photo catalogue does not extend router protocol compatibility.

## Images, screenshots and trademarks

The current `livebox-logo.svg` and CSS wallpaper are original project assets. Public screenshots are captured from a clean local instance, with no personal wallpaper, live device list or private network data. They show the actual application, not a simulated router connection.

An owner-supplied legacy PNG had no documented redistribution license. It is excluded from this public copy; the unused legacy logo URL returns the current project SVG. The current user interface already uses that SVG and is unchanged. The original private asset remains in the private project.

No original Freebox screenshot, vendor-provided corporate-logo image or proprietary router frontend bundle is included. The separately licensed hardware photographs are credited above; unknown models use a neutral pictogram. Orange, Livebox, Freebox and TP-Link names and trademarks remain with their respective owners. No trademark license or affiliation is implied.

## Maintainer checklist

When updating dependencies, regenerate the inventory and preserve relevant license and NOTICE files. Inspect native/bundled components rather than assuming every package is MIT. Review any newly copied code or asset before including it in a release.

## V5 terminal dependencies

AsyncSSH 2.24.1 is distributed **unmodified under EPL-2.0**, with the upstream secondary GPL alternative. Its full license is retained in [licenses/python-asyncssh.txt](licenses/python-asyncssh.txt). The corresponding source is available from [the 2.24.1 source distribution](https://pypi.org/project/asyncssh/2.24.1/#files) and [the upstream release](https://github.com/ronf/asyncssh/tree/v2.24.1). This separately licensed library is not relabeled MIT. Distributors must preserve its notices and make its source available as required by EPL-2.0; changes to that library must follow its license.

xterm.js 6.0.0 and FitAddon 0.11.0 are MIT licensed. Their copyright and permission notices are retained in [xterm.js](licenses/npm-xterm-xterm.txt) and [FitAddon](licenses/npm-xterm-addon-fit.txt).
