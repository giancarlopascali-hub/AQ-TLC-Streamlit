# AQ-TLC Desktop v1.2 for Windows (64-bit)

The portable Windows app now includes the current Desktop analysis interface and backend.

- Adjust one common lane width for all detected lanes within the displayed safe limit. The settings panel scrolls when space is limited.
- Use **Shoulder sensitivity** to inspect possible overlapping peaks. The default **Off** setting retains ordinary detection. Review each proposed cluster with **Split** or **Keep single**.
- Compare the measured densitogram with the total fit and fitted component curves. Split component areas are model-allocated estimates from measured Width%-controlled windows; gaps between disjoint windows are excluded. The table and report distinguish these areas from model integrals and include fit diagnostics.
- Fitted peak geometry is read-only until the cluster is kept as a single ordinary peak. Undo restores shoulder choices and settings.
- Report export offers a printable popup and a visible **Download report HTML** link.

Extract the entire `AQ-TLC-Desktop-v1.2-Windows-x64.zip` and run `AQ-TLC-Desktop.exe` with its `_internal` folder beside it. The app runs locally without Python or an internet connection. The analysis workspace is temporary, so export reports before closing the app.

The packaged executable passed interface, profile, crop, synthetic shoulder-split, and area-conservation smoke checks.
