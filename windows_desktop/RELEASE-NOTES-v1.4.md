# AQ-TLC Desktop v1.4 for Windows (64-bit)

This portable release adds the two shoulder-fitting modes from the online Desktop app.

- With Shoulder sensitivity above Off, **Default asymmetry** is checked initially and uses the original deconvolution calculation.
- Uncheck it to show **Maximum peak asymmetry (R)**. The range is 1.0–5.0, starting at 1.0. Both fitted components must stay within the selected left/right width ratio, and a split is retained only when its squared error stays within 5% of the best unrestricted fit and passes the existing quality checks.
- Changing either control recalculates the profiles, peak areas, table, and report. The fit summary identifies which mode was used.
- When Shoulder sensitivity is Off, both controls are hidden and ordinary peak detection is used.

The Area Calibration rules from v1.3 remain available, including averaging replicate standards and the assumed zero-area/zero-amount point.

Extract the entire `AQ-TLC-Desktop-v1.4-Windows-x64.zip` and run `AQ-TLC-Desktop.exe` with its `_internal` folder beside it. The app runs locally without Python or an internet connection. Export reports before closing the temporary analysis session.
