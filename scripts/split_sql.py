"""Split a SQL file into statements, respecting quotes, dollar quotes and comments.

Used to apply db/*.sql through APIs that run one statement at a time:
  python3 scripts/split_sql.py db/schema.sql > /tmp/statements.json
"""
import json
import re
import sys


def split_sql(text):
    statements, buf, i, n = [], [], 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith('--', i):                      # line comment
            j = text.find('\n', i)
            i = n if j == -1 else j + 1
            continue
        if text.startswith('/*', i):                      # block comment
            j = text.find('*/', i + 2)
            i = n if j == -1 else j + 2
            continue
        if c == "'":                                       # string literal
            j = i + 1
            while j < n:
                if text[j] == "'" and j + 1 < n and text[j + 1] == "'":
                    j += 2
                    continue
                if text[j] == "'":
                    break
                j += 1
            buf.append(text[i:j + 1])
            i = j + 1
            continue
        m = re.match(r'\$[A-Za-z_]*\$', text[i:])         # dollar quote
        if m:
            tag = m.group(0)
            j = text.find(tag, i + len(tag))
            j = n if j == -1 else j + len(tag)
            buf.append(text[i:j])
            i = j
            continue
        if c == '\\' and (i == 0 or text[i - 1] == '\n'):   # psql meta-command line
            j = text.find('\n', i)
            i = n if j == -1 else j + 1
            continue
        if c == ';':
            stmt = ''.join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    stmt = ''.join(buf).strip()
    if stmt:
        statements.append(stmt)
    return statements


if __name__ == '__main__':
    out = []
    for path in sys.argv[1:]:
        out.extend(split_sql(open(path, encoding='utf-8').read()))
    json.dump(out, sys.stdout)
