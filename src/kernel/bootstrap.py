"""
Pyodide bootstrap — runs once at kernel init.

Provides three Python-side helpers the worker calls per request:

* `__notebook_analyse(source)` — static AST scan returning JSON-encoded
  reads/writes for a cell body. Used by the orchestrator's DAG layer.
* `__notebook_repr(value)` — best-effort Jupyter-style MIME bundle for
  the cell's last expression value.
* `__notebook_post_execute(result_value)` — captures any open matplotlib
  figures as SVG bundles and closes them, matching Jupyter's
  ``%matplotlib inline`` post-execute behaviour.

Imported on the JS side via `?raw` so this file gets real Python
syntax highlighting and tooling instead of being a multi-hundred-line
backtick string in pyodide-worker.ts.
"""

import ast
import io
import os
import sys
import json
import builtins as _builtins
import contextlib

# Pyodide's matplotlib defaults to the webagg backend, which does
# `from js import document` and fails in a Web Worker (no DOM here).
# Force the non-interactive Agg backend before any matplotlib import.
# Users can still override via os.environ['MPLBACKEND'] = ... in a cell.
os.environ.setdefault('MPLBACKEND', 'Agg')

# Under Agg, plt.show() emits a UserWarning ("FigureCanvasAgg is
# non-interactive, and thus cannot be shown."). __notebook_post_execute
# already inlines any open figure; the warning is just noise. Suppress it
# at registration time so it's filtered before any matplotlib import.
import warnings
warnings.filterwarnings(
    'ignore',
    message=r'.*FigureCanvasAgg is non-interactive.*',
    category=UserWarning,
)

# ── static analysis ──────────────────────────────────────────────────────

_PY_BUILTINS = set(dir(_builtins))

class _ScopeVisitor(ast.NodeVisitor):
    def __init__(self):
        self.reads = set()
        self.writes = set()
        self.locals_stack = [set()]  # tracks names bound inside enclosing functions/comprehensions

    def _is_local(self, name):
        return any(name in scope for scope in self.locals_stack)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            if not self._is_local(node.id) and node.id not in _PY_BUILTINS:
                self.reads.add(node.id)
        elif isinstance(node.ctx, (ast.Store, ast.Del)):
            if len(self.locals_stack) == 1:  # top-level binding
                self.writes.add(node.id)

    def visit_FunctionDef(self, node):
        self.writes.add(node.name)
        self._enter_scope(node)

    def visit_AsyncFunctionDef(self, node):
        self.writes.add(node.name)
        self._enter_scope(node)

    def visit_ClassDef(self, node):
        self.writes.add(node.name)
        for base in node.bases:
            self.visit(base)
        for kw in node.keywords:
            self.visit(kw)
        # Class body is its own scope-ish; skip body to avoid misclassifying class-attr names as writes.

    def visit_Import(self, node):
        for alias in node.names:
            name = alias.asname or alias.name.split('.')[0]
            self.writes.add(name)

    def visit_ImportFrom(self, node):
        for alias in node.names:
            name = alias.asname or alias.name
            if name == '*':
                continue  # we cannot know what * imports without executing
            self.writes.add(name)

    def visit_For(self, node):
        # The loop variable is a top-level binding when at module scope.
        self._collect_assign_targets(node.target)
        self.generic_visit(node)

    def visit_With(self, node):
        for item in node.items:
            if item.optional_vars is not None:
                self._collect_assign_targets(item.optional_vars)
        self.generic_visit(node)

    def visit_Try(self, node):
        for handler in node.handlers:
            if handler.name and len(self.locals_stack) == 1:
                self.writes.add(handler.name)
        self.generic_visit(node)

    def _collect_assign_targets(self, target):
        if len(self.locals_stack) != 1:
            return
        if isinstance(target, ast.Name):
            self.writes.add(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._collect_assign_targets(elt)
        elif isinstance(target, ast.Starred):
            self._collect_assign_targets(target.value)

    def _enter_scope(self, node):
        local = set()
        for arg in getattr(node.args, 'args', []):
            local.add(arg.arg)
        for arg in getattr(node.args, 'kwonlyargs', []):
            local.add(arg.arg)
        if getattr(node.args, 'vararg', None):
            local.add(node.args.vararg.arg)
        if getattr(node.args, 'kwarg', None):
            local.add(node.args.kwarg.arg)
        self.locals_stack.append(local)
        for n in node.body:
            self.visit(n)
        self.locals_stack.pop()


def __notebook_analyse(source):
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return json.dumps({"reads": [], "writes": [], "syntaxError": str(e)})
    v = _ScopeVisitor()
    v.visit(tree)
    return json.dumps({"reads": sorted(v.reads), "writes": sorted(v.writes)})


# ── execution capture ────────────────────────────────────────────────────

def __notebook_matplotlib_svg(value):
    """If value is a matplotlib Figure (or has gcf attached), render to SVG."""
    try:
        from matplotlib.figure import Figure
    except ImportError:
        return None
    if not isinstance(value, Figure):
        return None
    import io
    buf = io.StringIO()
    try:
        value.savefig(buf, format='svg', bbox_inches='tight')
    except Exception:
        return None
    return buf.getvalue()


def __notebook_repr(value):
    """Best-effort MIME bundle for a Python value."""
    if value is None:
        return None
    bundle = {}
    # Prefer the Jupyter-style _repr_mimebundle_ if available.
    repr_bundle = getattr(value, '_repr_mimebundle_', None)
    if callable(repr_bundle):
        try:
            data = repr_bundle()
            if isinstance(data, tuple):
                data = data[0]
            if isinstance(data, dict):
                bundle.update(data)
        except Exception:
            pass
    for mime, attr in (
        ('image/svg+xml', '_repr_svg_'),
        ('image/png', '_repr_png_'),
        ('text/html', '_repr_html_'),
        ('text/latex', '_repr_latex_'),
        ('application/json', '_repr_json_'),
    ):
        if mime in bundle:
            continue
        m = getattr(value, attr, None)
        if callable(m):
            try:
                v = m()
                if v is not None:
                    bundle[mime] = v
            except Exception:
                pass
    # matplotlib Figures don't expose _repr_svg_; render via savefig instead.
    # The default _repr_html_ is a base64 PNG — we prefer SVG for Typst.
    if 'image/svg+xml' not in bundle:
        svg = __notebook_matplotlib_svg(value)
        if svg is not None:
            bundle['image/svg+xml'] = svg
    if 'text/plain' not in bundle:
        try:
            bundle['text/plain'] = repr(value)
        except Exception:
            bundle['text/plain'] = '<unrepr-able>'
    return bundle


def __notebook_post_execute(result_value):
    """Render and close any open matplotlib figures.

    Returns a list of MIME bundles for figures NOT represented by
    result_value, so a cell ending in 'plt.gcf()' doesn't double-render.
    Closing every open figure prevents accumulation across cells —
    matching Jupyter's %matplotlib inline post-execute behaviour.
    """
    bundles = []
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        return bundles
    try:
        from matplotlib.figure import Figure
        result_fig_num = result_value.number if isinstance(result_value, Figure) else None
    except Exception:
        result_fig_num = None
    for num in plt.get_fignums():
        if num == result_fig_num:
            continue
        fig = plt.figure(num)
        bundle = __notebook_repr(fig)
        if bundle:
            bundles.append(bundle)
        plt.close(fig)
    if result_fig_num is not None:
        try:
            plt.close(plt.figure(result_fig_num))
        except Exception:
            pass
    return bundles
