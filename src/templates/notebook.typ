// notebook.typ — the template that gives meaning to #cell, #cell-output,
// #unsupported-output, and the status surface. Notebooks `#import` this and
// then the rest of the file is just authoring.
//
// v0: minimal placeholders so documents using these calls compile. Real
// implementation lands when the kernel + adapter pipeline produces outputs.

// `body` is already a Typst raw block (e.g. ```python ... ```). Just style
// the surrounding container; we don't rewrap it as raw(). `lazy` is honoured
// by the orchestrator (skip auto-rerun on upstream changes); the template
// uses it to draw a subtler stroke so the user can spot frozen cells.
#let cell(id: none, lang: "python", lazy: false, body) = block(
  width: 100%, fill: rgb("#f4f4f7"),
  stroke: (left: 2pt + rgb(if lazy { "#9ca3af" } else { "#7c3aed" })),
  inset: (x: 12pt, y: 10pt), radius: (right: 4pt),
  body,
)

#let cell-output(body) = block(
  width: 100%, inset: (x: 12pt, y: 8pt), body,
)

#let unsupported-output(mime: "") = block(
  width: 100%, fill: rgb("#fef3c7"), stroke: (left: 2pt + rgb("#d97706")),
  inset: (x: 12pt, y: 10pt), radius: (right: 4pt),
  [
    #text(size: 8pt, weight: "bold", fill: rgb("#92400e"), tracking: 1pt)[UNSUPPORTED OUTPUT]
    #linebreak()
    #text(size: 9pt)[The output type #raw(mime) does not have an adapter installed. Outputs of this type are shown as a placeholder rather than rendered.]
  ],
)

#let notebook(title: none, kernel: "python", body) = {
  set document(title: if title == none { "Notebook" } else { title })
  // height: auto turns the doc into one continuous page rather than
  // paginating to A4 height with white space at the bottom of each.
  // PDF export later may want fixed pages — at that point we'll thread
  // a `pageless` flag (default true here, false from the PDF code path).
  set page(width: 8.5in, height: auto, margin: (x: 0.8in, y: 0.9in))
  set text(font: ("Inter", "Helvetica Neue", "Arial"), size: 10.5pt)
  if title != none {
    text(size: 22pt, weight: "bold", title)
    v(12pt)
  }
  body
}
