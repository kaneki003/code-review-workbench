# Centre section refinement

This note records component changes and checks at that stage. The [current contract](figma-interaction-contract.md) and [later lifecycle refinement](lifecycle-refinement.md) govern current writing, dismissal, publication, and activity behavior. Earlier screen/instance counts are historical evidence.

Updated the existing Figma file’s 36 code-centre states with shared inline cards, a GitHub-style continuous composer, left disclosure controls, theme-only card/tag/button colours, and the file-header Mark File Reviewed checkbox. Standard green/red line-change colours remain bound to the existing code-row masters. The three former right-column writing states now show the composer under its source card and reuse the established Context companion; other columns retain their layout.

The representative suggestion and writing state were checked before reuse. Final checks cover 71 card instances, four composers, 36 reviewed controls, 512 standard-colour code rows, Inter / JetBrains Mono fonts, no overflowing card content, no complete-UI rasters, and no missing saved destinations. Wide, narrow, GitHub-thread and light-theme views were inspected. Live-player click-through and real typing were not exercised.

Exact IDs and validation are in figma-centre-state.json and figma-centre-checks.json. Future edits should use the Centre/Inline card, Centre/Comment composer and Centre/Mark file reviewed masters.


Correction: AI suggestions now match the reference’s labelled Observation / Hypothesis / Source chip / Limit structure, with the extra Related source row hidden. The existing writing screen is explicitly named “Use as feedback / expanded inline composer”; it opens at the suggestion with all writing controls visible. Earlier code is retained behind Show earlier changes. Reference-format, route, viewport and narrow-source-chip checks pass; details are in figma-centre-feedback-correction.json.
