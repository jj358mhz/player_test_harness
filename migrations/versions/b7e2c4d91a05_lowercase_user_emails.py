"""lowercase user emails

Login looks emails up lowercased, but bootstrap used to store
BOOTSTRAP_ADMIN_EMAIL as typed, so a mixed-case admin could never log in.

Revision ID: b7e2c4d91a05
Revises: a43e3e53ca5f
Create Date: 2026-10-26 18:50:00.000000

"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b7e2c4d91a05"
down_revision: Union[str, None] = "a43e3e53ca5f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Skip a row whose lowercase form is already taken (unique email).
    op.execute(
        "UPDATE users SET email = lower(trim(email)) "
        "WHERE email != lower(trim(email)) "
        "AND lower(trim(email)) NOT IN (SELECT email FROM users)"
    )


def downgrade() -> None:
    # The original casing isn't kept.
    pass
