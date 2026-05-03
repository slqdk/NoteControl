// Ambient type declarations.
//
// The triple-slash reference below pulls in Vite's own type
// declarations for:
//   - CSS / SCSS / LESS imports as side-effect modules
//     (`import './foo.css';` becomes valid)
//   - CSS Modules (`import classes from './foo.module.css';`)
//   - import.meta.env shape
//   - The SVG / image asset import wildcards
//
// Without this reference, a strict-mode `tsc -b` (which
// `npm run build` runs before `vite build`) refuses every
// CSS import with "Cannot find module './foo.css' or its
// corresponding type declarations." Vite's dev server is
// permissive about this -- production builds are not.
//
// We don't add custom CSS module declarations on top, because
// vite/client already declares `*.css` as an empty module, and
// duplicating that with a different shape would cause a separate
// "subsequent property declarations must have the same type"
// error.

/// <reference types="vite/client" />
