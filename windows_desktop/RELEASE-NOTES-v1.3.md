# AQ-TLC Desktop v1.3 for Windows (64-bit)

This portable Windows release carries the current Desktop Area Calibration update.

- Standards entered with the same known amount are treated as replicates. Their measured areas are averaged into one calibration level.
- Calibration assumes zero area means zero amount; this is an assumed point, not a measured standard. One positive standard gives a proportional line. Two positive standards and the zero point define a quadratic. Three or more positive standards use local neighbouring measured levels, with the zero point used below the first standard.
- If an in-range quadratic bends backwards, that segment uses a straight line. Above the highest measured standard, estimates extend the line through the last two measured standards. The table and report identify estimates outside the measured range.
- A zero-amount standard with positive area makes calibration unavailable because it conflicts with the assumed zero point.

Peak areas still use each lane's separately rescaled signal. Check the response with multiple known amounts before relying on absolute results.

Extract the entire `AQ-TLC-Desktop-v1.3-Windows-x64.zip` and run `AQ-TLC-Desktop.exe` with its `_internal` folder beside it. The app runs locally without Python or an internet connection. The analysis workspace is temporary, so export reports before closing the app.
