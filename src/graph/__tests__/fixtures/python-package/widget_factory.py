"""A module named after the single function it declares.

That shape is what makes a symbol lookup hard: the `file:` node's name is the
basename, which matches the query as strongly as the function does and sits in
a much shorter FTS field, so the file used to come back first.
"""

from .models import Widget


def widget_factory(name: str) -> Widget:
    return Widget(name)
