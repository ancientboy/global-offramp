"""Normalize equivalent spreadsheet XML namespace spelling for ExcelJS interoperability.
Artifact Tool is the workbook author; this does not change cells or formats.
"""
import re, sys, zipfile, io
from pathlib import Path
p=Path(sys.argv[1])
out=io.BytesIO()
with zipfile.ZipFile(p) as source, zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as dest:
    for entry in source.infolist():
        data=source.read(entry.filename)
        if entry.filename.endswith('.xml') and b'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' in data:
            data=data.replace(b'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',b'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
            data=re.sub(rb'(<\/?)(x:)',rb'\1',data)
        dest.writestr(entry,data)
p.write_bytes(out.getvalue())
