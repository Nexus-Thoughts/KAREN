# KAREN Steering Documents — Exact IRIS UI

This package contains the complete steering-document set for KAREN.

## Critical instruction
`IRIS-PAYROLL-main.zip` is included as the canonical UI reference.

The KAREN frontend must reproduce the IRIS UI exactly. Do not use the documentation as a substitute for inspecting the IRIS source.

Recommended repository placement:

```text
project/
├── CLAUDE.md
├── docs/
│   ├── 01_PRD.md
│   ├── ...
│   ├── 12_UI_UX_SPEC.md
│   ├── 16_IRIS_SOURCE_OF_TRUTH_MANIFEST.md
│   ├── 17_IRIS_TO_KAREN_SCREEN_MAPPING.md
│   ├── 18_IRIS_REUSE_AND_EXTRACTION_RULES.md
│   └── 19_DEFINITION_OF_DONE.md
└── IRIS-PAYROLL-main/   # canonical UI reference
```

If the source is stored elsewhere, update the path in `CLAUDE.md`, but do not replace the source with screenshots or a prose approximation.
