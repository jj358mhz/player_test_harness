"""Admin routes: manage Uplynk accounts and sync their channels."""

from __future__ import annotations

from flask import Blueprint, abort, current_app, flash, redirect, render_template, url_for

from app.admin.audit import log_admin_event
from app.admin.decorators import admin_required
from app.admin.forms import UplynkAccountForm
from app.crypto import decrypt, encrypt, mask
from app.models import UplynkAccount, db
from app.uplynk.scoped_env import ScopedEnvParseError, parse_scoped_env
from app.uplynk.sync import sync_account

bp = Blueprint("admin", __name__, url_prefix="/admin")


def _apply_scoped_env(acct: UplynkAccount, file_storage) -> str | None:
    """Populate scoped-key fields from an uploaded .env file.

    Returns an error message on failure, None on success or when no file was uploaded.
    """
    if not file_storage or not file_storage.filename:
        return None
    try:
        parsed = parse_scoped_env(file_storage.read())
    except ScopedEnvParseError as e:
        return f"Scoped API Key file is invalid: {e}"
    acct.scoped_kid = parsed.kid
    acct.scoped_sub = parsed.sub
    acct.scoped_private_b64_encrypted = encrypt(parsed.private_b64)
    acct.scoped_scp = parsed.scp
    return None


@bp.route("/uplynk-accounts")
@admin_required
def list_accounts():
    accounts = db.session.query(UplynkAccount).order_by(UplynkAccount.label).all()
    previews = {}
    for acct in accounts:
        try:
            previews[acct.id] = mask(decrypt(acct.api_key_encrypted))
        except Exception:
            previews[acct.id] = "(decrypt failed)"
    return render_template(
        "admin/uplynk_accounts_list.html",
        accounts=accounts,
        previews=previews,
        sync_interval=current_app.config["CHANNEL_SYNC_INTERVAL"],
    )


@bp.route("/uplynk-accounts/new", methods=["GET", "POST"])
@admin_required
def new_account():
    form = UplynkAccountForm()
    if form.validate_on_submit():
        if not form.api_key.data:
            flash("API Key is required when creating a new account.", "error")
        elif db.session.query(UplynkAccount).filter_by(label=form.label.data.strip()).first():
            flash(f"An account labelled '{form.label.data.strip()}' already exists.", "error")
        else:
            acct = UplynkAccount(
                label=form.label.data.strip(),
                workspace_id=form.workspace_id.data.strip(),
                api_key_encrypted=encrypt(form.api_key.data.strip()),
            )
            err = _apply_scoped_env(acct, form.scoped_env_file.data)
            if err:
                flash(err, "error")
            else:
                db.session.add(acct)
                db.session.commit()
                log_admin_event(
                    "uplynk_account", "create", f"Created Uplynk account '{acct.label}'", acct.label
                )
                flash(
                    f"Uplynk account '{acct.label}' created. Run Sync to pull channels.", "success"
                )
                return redirect(url_for("admin.list_accounts"))
    return render_template("admin/uplynk_account_form.html", form=form, mode="new")


@bp.route("/uplynk-accounts/<int:account_id>/edit", methods=["GET", "POST"])
@admin_required
def edit_account(account_id: int):
    acct = db.session.get(UplynkAccount, account_id) or abort(404)
    form = UplynkAccountForm(obj=acct)

    if form.validate_on_submit():
        acct.label = form.label.data.strip()
        acct.workspace_id = form.workspace_id.data.strip()
        if form.api_key.data:
            acct.api_key_encrypted = encrypt(form.api_key.data.strip())
        err = _apply_scoped_env(acct, form.scoped_env_file.data)
        if err:
            db.session.rollback()
            flash(err, "error")
        else:
            db.session.commit()
            log_admin_event(
                "uplynk_account", "update", f"Updated Uplynk account '{acct.label}'", acct.label
            )
            flash(f"Uplynk account '{acct.label}' updated.", "success")
            return redirect(url_for("admin.list_accounts"))

    return render_template("admin/uplynk_account_form.html", form=form, mode="edit", account=acct)


@bp.route("/uplynk-accounts/<int:account_id>/scoped-key/delete", methods=["POST"])
@admin_required
def delete_scoped_key(account_id: int):
    acct = db.session.get(UplynkAccount, account_id) or abort(404)
    acct.scoped_kid = acct.scoped_sub = acct.scoped_private_b64_encrypted = acct.scoped_scp = None
    db.session.commit()
    log_admin_event(
        "uplynk_account", "update", f"Removed scoped key from '{acct.label}'", acct.label
    )
    flash(f"Scoped key removed from '{acct.label}'. Sync will use classic auth.", "info")
    return redirect(url_for("admin.edit_account", account_id=acct.id))


@bp.route("/uplynk-accounts/<int:account_id>/delete", methods=["POST"])
@admin_required
def delete_account(account_id: int):
    acct = db.session.get(UplynkAccount, account_id) or abort(404)
    label = acct.label
    db.session.delete(acct)
    db.session.commit()
    log_admin_event("uplynk_account", "delete", f"Deleted Uplynk account '{label}'", label)
    flash(f"Uplynk account '{label}' deleted.", "info")
    return redirect(url_for("admin.list_accounts"))


@bp.route("/uplynk-accounts/<int:account_id>/sync", methods=["POST"])
@admin_required
def sync_account_route(account_id: int):
    acct = db.session.get(UplynkAccount, account_id) or abort(404)
    result = sync_account(acct)
    log_admin_event("sync", "error" if result.error else "run", result.summary, acct.label)
    flash(result.summary, "error" if result.error else "success")
    return redirect(url_for("admin.list_accounts"))


@bp.route("/uplynk-accounts/sync-all", methods=["POST"])
@admin_required
def sync_all():
    accounts = db.session.query(UplynkAccount).order_by(UplynkAccount.label).all()
    for acct in accounts:
        result = sync_account(acct)
        log_admin_event("sync", "error" if result.error else "run", result.summary, acct.label)
        flash(result.summary, "error" if result.error else "success")
    if not accounts:
        flash("No Uplynk accounts to sync yet.", "info")
    return redirect(url_for("main.index"))
