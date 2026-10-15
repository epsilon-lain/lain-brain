"""Presentation-only superscript normalization; no missing factors are inserted."""
import re
SUPERSCRIPTS=str.maketrans('⁰¹²³⁴⁵⁶⁷⁸⁹','0123456789')
PATTERN=re.compile(r'(?<=[A-Za-z0-9_)])[⁰¹²³⁴⁵⁶⁷⁸⁹]+')
def normalize(text):
    return PATTERN.sub(lambda m:'**'+m.group().translate(SUPERSCRIPTS),text)
