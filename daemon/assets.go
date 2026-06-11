// Package occultd is the module root. Its only job is to embed the dashboard's
// static web assets into the binary so occultd ships as a single file with no
// external web directory to deploy.
package occultd

import "embed"

// WebFS holds the dashboard (index.html, app.js, styles.css, vendor/). The
// "all:" prefix ensures files that start with "_" or "." are embedded too.
//
//go:embed all:web
var WebFS embed.FS
