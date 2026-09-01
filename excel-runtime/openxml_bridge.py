#!/usr/bin/env python3
import json
import os
import re
import shutil
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN, "r": DOC_REL, "pr": PKG_REL}
ET.register_namespace("", MAIN)
ET.register_namespace("r", DOC_REL)
CELL_RE = re.compile(r"^([A-Z]+)([1-9][0-9]*)$")


def q(name):
    return f"{{{MAIN}}}{name}"


def col_to_num(col):
    value = 0
    for ch in col:
        value = value * 26 + ord(ch) - 64
    return value


def num_to_col(value):
    out = ""
    while value > 0:
        value -= 1
        out = chr(65 + value % 26) + out
        value //= 26
    return out


def parse_ref(ref):
    match = CELL_RE.match(str(ref or "").upper())
    if not match:
        raise ValueError(f"invalid A1 cell reference: {ref}")
    return int(match.group(2)), col_to_num(match.group(1))


def a1(r1, c1, r2=None, c2=None):
    r2 = r1 if r2 is None else r2
    c2 = c1 if c2 is None else c2
    first = f"{num_to_col(c1)}{r1}"
    second = f"{num_to_col(c2)}{r2}"
    return first if first == second else f"{first}:{second}"


def text_nodes(node):
    if node is None:
        return ""
    return "".join((child.text or "") for child in node.iter(q("t")))


def load_shared_strings(zf):
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [text_nodes(si) for si in root.findall("m:si", NS)]


def load_styles(zf):
    try:
        root = ET.fromstring(zf.read("xl/styles.xml"))
    except KeyError:
        return {"xfs": [], "fonts": [], "numfmts": {}}
    fonts = []
    fonts_node = root.find("m:fonts", NS)
    if fonts_node is not None:
        for font in fonts_node.findall("m:font", NS):
            fonts.append({"bold": font.find("m:b", NS) is not None})
    numfmts = {}
    num_node = root.find("m:numFmts", NS)
    if num_node is not None:
        for item in num_node.findall("m:numFmt", NS):
            try:
                numfmts[int(item.get("numFmtId", "0"))] = item.get("formatCode", "")
            except ValueError:
                pass
    xfs = []
    xf_node = root.find("m:cellXfs", NS)
    if xf_node is not None:
        for xf in xf_node.findall("m:xf", NS):
            alignment = xf.find("m:alignment", NS)
            xfs.append({
                "fontId": int(xf.get("fontId", "0") or 0),
                "numFmtId": int(xf.get("numFmtId", "0") or 0),
                "wrapText": alignment is not None and alignment.get("wrapText") in ("1", "true", "True"),
            })
    return {"xfs": xfs, "fonts": fonts, "numfmts": numfmts}


BUILTIN_FORMATS = {
    0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
    9: "0%", 10: "0.00%", 14: "mm-dd-yy", 22: "m/d/yy h:mm", 49: "@",
}


def style_meta(style_id, styles):
    if style_id < 0 or style_id >= len(styles["xfs"]):
        return None, False, False
    xf = styles["xfs"][style_id]
    font_id = xf["fontId"]
    bold = 0 <= font_id < len(styles["fonts"]) and styles["fonts"][font_id].get("bold", False)
    fmt_id = xf["numFmtId"]
    number_format = styles["numfmts"].get(fmt_id, BUILTIN_FORMATS.get(fmt_id, "General"))
    return number_format, bool(bold), bool(xf.get("wrapText"))


def workbook_parts(zf):
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rel_targets = {rel.get("Id"): rel.get("Target") for rel in rels.findall("pr:Relationship", NS)}
    sheets = []
    sheets_node = workbook.find("m:sheets", NS)
    if sheets_node is None:
        return []
    for sheet in sheets_node.findall("m:sheet", NS):
        rid = sheet.get(f"{{{DOC_REL}}}id")
        target = rel_targets.get(rid)
        if not target:
            continue
        if target.startswith("/"):
            path = target.lstrip("/")
        else:
            path = os.path.normpath(os.path.join("xl", target)).replace("\\", "/")
        sheets.append({"name": sheet.get("name", ""), "path": path})
    return sheets


def cell_value(cell, shared):
    formula_node = cell.find("m:f", NS)
    formula = None if formula_node is None else "=" + (formula_node.text or "")
    ctype = cell.get("t", "")
    if ctype == "inlineStr":
        text = text_nodes(cell.find("m:is", NS))
    else:
        value_node = cell.find("m:v", NS)
        raw = "" if value_node is None or value_node.text is None else value_node.text
        if ctype == "s":
            try:
                text = shared[int(raw)]
            except (ValueError, IndexError):
                text = raw
        elif ctype == "b":
            text = "TRUE" if raw == "1" else "FALSE"
        else:
            text = raw
    return text, formula


def sheet_cells(root):
    data = root.find("m:sheetData", NS)
    if data is None:
        data = ET.SubElement(root, q("sheetData"))
    cells = {}
    rows = {}
    for row in data.findall("m:row", NS):
        try:
            row_num = int(row.get("r", "0") or 0)
        except ValueError:
            row_num = 0
        if row_num:
            rows[row_num] = row
        for cell in row.findall("m:c", NS):
            ref = cell.get("r")
            if ref:
                cells[ref.upper()] = cell
    return data, rows, cells


def ref_in_range(ref, range_ref):
    try:
        if ":" not in range_ref:
            return ref == range_ref
        left, right = range_ref.split(":", 1)
        r, c = parse_ref(ref)
        r1, c1 = parse_ref(left)
        r2, c2 = parse_ref(right)
        return min(r1, r2) <= r <= max(r1, r2) and min(c1, c2) <= c <= max(c1, c2)
    except ValueError:
        return False


def merge_owner(root, ref):
    merges_node = root.find("m:mergeCells", NS)
    if merges_node is None:
        return None, None
    for item in merges_node.findall("m:mergeCell", NS):
        range_ref = item.get("ref", "")
        if not range_ref or not ref_in_range(ref, range_ref):
            continue
        owner = range_ref.split(":", 1)[0].upper()
        return owner, range_ref
    return None, None


def inspect_sheet(name, root, shared, styles, max_rows, max_cols):
    merges_node = root.find("m:mergeCells", NS)
    merges = [] if merges_node is None else [item.get("ref", "") for item in merges_node.findall("m:mergeCell", NS) if item.get("ref")]
    _, _, cells = sheet_cells(root)
    parsed = []
    min_r = min_c = None
    max_r = max_c = 0
    for ref, cell in cells.items():
        try:
            row, col = parse_ref(ref)
        except ValueError:
            continue
        if row > max_rows or col > max_cols:
            continue
        text, formula = cell_value(cell, shared)
        try:
            style_id = int(cell.get("s", "0") or 0)
        except ValueError:
            style_id = 0
        number_format, bold, wrap = style_meta(style_id, styles)
        merge = next((m for m in merges if ref_in_range(ref, m)), None)
        interesting = bool(text or formula or merge or style_id != 0)
        if not interesting:
            continue
        min_r = row if min_r is None else min(min_r, row)
        min_c = col if min_c is None else min(min_c, col)
        max_r = max(max_r, row)
        max_c = max(max_c, col)
        item = {"address": ref, "text": text}
        if formula:
            item["formula"] = formula
        if merge:
            item["merge"] = merge
        if number_format and number_format != "General":
            item["numberFormat"] = number_format
        if bold:
            item["bold"] = True
        if wrap:
            item["wrapText"] = True
        parsed.append(item)
    dimension = root.find("m:dimension", NS)
    used = dimension.get("ref") if dimension is not None and dimension.get("ref") else None
    if not used:
        used = a1(min_r or 1, min_c or 1, max_r or 1, max_c or 1)
    captured = a1(1, 1, max_rows, max_cols)
    truncated = False
    if used and ":" in used:
        try:
            end = used.split(":", 1)[1]
            er, ec = parse_ref(end)
            captured = a1(1, 1, min(er, max_rows), min(ec, max_cols))
            truncated = er > max_rows or ec > max_cols
        except ValueError:
            pass
    parsed.sort(key=lambda item: parse_ref(item["address"]))
    return {
        "name": name,
        "usedRange": used or "A1",
        "capturedRange": captured,
        "truncated": truncated,
        "merges": merges,
        "cells": parsed,
        "warnings": [],
    }


def ensure_cell(root, ref):
    row_num, col_num = parse_ref(ref)
    data, rows, cells = sheet_cells(root)
    if ref in cells:
        return cells[ref]
    row = rows.get(row_num)
    if row is None:
        row = ET.Element(q("row"), {"r": str(row_num)})
        inserted = False
        for index, existing in enumerate(list(data)):
            try:
                existing_num = int(existing.get("r", "0") or 0)
            except ValueError:
                existing_num = 0
            if existing_num > row_num:
                data.insert(index, row)
                inserted = True
                break
        if not inserted:
            data.append(row)
    cell = ET.Element(q("c"), {"r": ref})
    inserted = False
    for index, existing in enumerate(list(row)):
        existing_ref = existing.get("r", "")
        try:
            _, existing_col = parse_ref(existing_ref)
        except ValueError:
            continue
        if existing_col > col_num:
            row.insert(index, cell)
            inserted = True
            break
    if not inserted:
        row.append(cell)
    return cell


def clear_value_nodes(cell):
    for child in list(cell):
        if child.tag in (q("v"), q("f"), q("is")):
            cell.remove(child)


def set_text(cell, value):
    clear_value_nodes(cell)
    cell.set("t", "inlineStr")
    inline = ET.SubElement(cell, q("is"))
    text = ET.SubElement(inline, q("t"))
    if value.startswith(" ") or value.endswith(" "):
        text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    text.text = value


def set_number(cell, value):
    clear_value_nodes(cell)
    cell.attrib.pop("t", None)
    node = ET.SubElement(cell, q("v"))
    node.text = str(float(value))


def set_formula(cell, value):
    clear_value_nodes(cell)
    cell.attrib.pop("t", None)
    node = ET.SubElement(cell, q("f"))
    node.text = str(value)[1:] if str(value).startswith("=") else str(value)


def set_clear(cell):
    clear_value_nodes(cell)
    cell.attrib.pop("t", None)


def update_dimension(root):
    _, _, cells = sheet_cells(root)
    coords = []
    for ref in cells:
        try:
            coords.append(parse_ref(ref))
        except ValueError:
            pass
    if not coords:
        ref = "A1"
    else:
        rows = [item[0] for item in coords]
        cols = [item[1] for item in coords]
        ref = a1(min(rows), min(cols), max(rows), max(cols))
    dimension = root.find("m:dimension", NS)
    if dimension is None:
        dimension = ET.Element(q("dimension"), {"ref": ref})
        root.insert(0, dimension)
    else:
        dimension.set("ref", ref)


def desired_text(value_type, value):
    if value_type == "clear":
        return ""
    if value_type == "formula":
        return str(value)
    if value_type == "number":
        try:
            number = float(value)
            return str(int(number)) if number.is_integer() else str(number)
        except (TypeError, ValueError):
            return str(value)
    return str(value)


def write_sheet(root, updates, shared):
    warnings = []
    _, _, cells = sheet_cells(root)
    written = []
    for update in updates:
        ref = str(update.get("cell", "")).upper()
        parse_ref(ref)

        owner, merge_range = merge_owner(root, ref)
        if owner and owner != ref:
            raise ValueError(f"refusing to write {ref}: it is inside merged range {merge_range}; write the top-left cell {owner} instead")

        existing_cell = cells.get(ref)
        previous_text = ""
        previous_formula = None
        if existing_cell is not None:
            previous_text, previous_formula = cell_value(existing_cell, shared)

        value_type = update.get("valueType") or "text"
        value = "" if update.get("value") is None else str(update.get("value"))
        shown = desired_text(value_type, value)
        previous_semantic = previous_formula if previous_formula else previous_text
        same_value = str(previous_semantic or "") == shown
        protected = bool(previous_text or previous_formula)
        allow_overwrite = update.get("allowOverwriteExisting") is True
        expected = update.get("expectedCurrentText")

        if protected and not same_value:
            if not allow_overwrite:
                raise ValueError(
                    f"refusing to overwrite non-empty template cell {ref} ({previous_text!r}); "
                    "write into an inspected blank destination or explicitly opt into a guarded overwrite"
                )
            if expected is None:
                raise ValueError(
                    f"guarded overwrite of {ref} requires expectedCurrentText from the latest patrol_excel_inspect result"
                )
            if str(expected) != str(previous_text):
                raise ValueError(
                    f"guarded overwrite of {ref} rejected: expectedCurrentText={expected!r}, actual={previous_text!r}; re-inspect the workbook"
                )

        cell = ensure_cell(root, ref)
        source_ref = update.get("copyFormatFrom")
        if source_ref:
            source = cells.get(str(source_ref).upper())
            if source is None:
                warnings.append(f"copy formatting {source_ref} -> {ref} skipped: source cell not found")
            elif source.get("s") is not None:
                cell.set("s", source.get("s"))

        if value_type == "clear":
            set_clear(cell)
        elif value_type == "number":
            set_number(cell, value)
        elif value_type == "formula":
            set_formula(cell, value)
        else:
            set_text(cell, value)
        written.append({"cell": ref, "text": shown, "previousText": previous_text})
        _, _, cells = sheet_cells(root)
    update_dimension(root)
    return written, warnings


def inspect_workbook(file_path, payload):
    with zipfile.ZipFile(file_path, "r") as zf:
        sheets = workbook_parts(zf)
        if not sheets:
            raise ValueError("workbook has no worksheets")
        selected = sheets
        if payload.get("sheetName"):
            selected = [item for item in sheets if item["name"] == payload["sheetName"]]
            if not selected:
                raise ValueError(f"Worksheet not found: {payload['sheetName']}")
        shared = load_shared_strings(zf)
        styles = load_styles(zf)
        result = []
        for item in selected:
            root = ET.fromstring(zf.read(item["path"]))
            result.append(inspect_sheet(
                item["name"], root, shared, styles,
                int(payload.get("maxRows", 80)), int(payload.get("maxColumns", 30)),
            ))
        return {
            "operation": "inspect",
            "path": file_path,
            "sheetNames": [item["name"] for item in sheets],
            "sheets": result,
        }


def write_workbook(file_path, payload):
    # Read every package part while the source workbook is open. Close that ZIP
    # before replacing the original path: Windows rejects replacement while the
    # source .xlsx still has an open handle.
    with zipfile.ZipFile(file_path, "r") as zf:
        sheets = workbook_parts(zf)
        if not sheets:
            raise ValueError("workbook has no worksheets")
        selected = [item for item in sheets if item["name"] == payload.get("sheetName")]
        if not selected:
            raise ValueError(f"Worksheet not found: {payload.get('sheetName')}")
        target = selected[0]
        shared = load_shared_strings(zf)
        root = ET.fromstring(zf.read(target["path"]))
        written, warnings = write_sheet(root, payload.get("updates") or [], shared)
        replacement = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        entries = [
            (info, replacement if info.filename == target["path"] else zf.read(info.filename))
            for info in zf.infolist()
        ]

    temp_fd, temp_path = tempfile.mkstemp(prefix="dsh-patrol-openxml-", suffix=".xlsx", dir=os.path.dirname(file_path))
    os.close(temp_fd)
    try:
        with zipfile.ZipFile(temp_path, "w") as out:
            for info, data in entries:
                out.writestr(info, data)
        shutil.copystat(file_path, temp_path)
        os.replace(temp_path, file_path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    return {
        "operation": "write",
        "path": file_path,
        "sheetName": target["name"],
        "written": written,
        "warnings": warnings,
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: openxml_bridge.py <payload.json>")
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    file_path = os.path.abspath(payload["filePath"])
    if not file_path.lower().endswith(".xlsx"):
        raise ValueError("OpenXML bridge only supports .xlsx workbooks")
    operation = payload.get("operation")
    if operation == "inspect":
        result = inspect_workbook(file_path, payload)
    elif operation == "write":
        result = write_workbook(file_path, payload)
    else:
        raise ValueError(f"Unsupported Excel operation: {operation}")
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"DSH Patrol OpenXML bridge failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
