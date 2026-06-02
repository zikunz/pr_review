"""Minimal example handler used to exercise the PR Cascade reviewer end to end."""

import sqlite3

from flask import request


def get_order(db: sqlite3.Connection):
    """Look up a single order by the id supplied in the query string."""
    order_id = request.args.get("orderId")
    cursor = db.execute(f"SELECT * FROM orders WHERE id = {order_id}")
    return cursor.fetchone()
