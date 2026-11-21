"""An owner's settings action waits for a reply already using the VM desktop."""

import fcntl
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))

import vm_console as ui


class VmOperationWaitTest(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory(prefix='fixture-wechat-vm-lock-')
        self.addCleanup(temp.cleanup)
        root = Path(temp.name) / 'locks'
        root.mkdir(mode=0o700)
        os.chmod(root, 0o700)
        mock = patch.object(ui, 'VM_LOCK_PATH', root / 'desktop.lock')
        mock.start()
        self.addCleanup(mock.stop)

    def hold(self, seconds):
        held = threading.Event()

        def reply():
            with ui.vm_operation():
                held.set()
                time.sleep(seconds)

        worker = threading.Thread(target=reply)
        worker.start()
        held.wait()
        return worker

    def test_waits_for_a_send_under_way_and_still_gives_up_eventually(self):
        # On 2026-11-16 a list-based group add failed as busy while a reply was being sent.
        worker = self.hold(0.6)
        try:
            with ui.vm_operation(wait=5):
                pass
        finally:
            worker.join()
        worker = self.hold(1.0)
        try:
            with self.assertRaises(ui.OperationBusy):
                with ui.vm_operation(wait=0.2):
                    pass
            # The listener itself never waits.
            with self.assertRaises(ui.OperationBusy):
                with ui.vm_operation():
                    pass
        finally:
            worker.join()

    def test_pending_owner_does_not_let_pollers_steal_the_lock_and_timeout_releases_claim(self):
        waiting = threading.Event()
        finished = threading.Event()
        errors = []
        original_acquire = ui._acquire_desktop

        def signal_waiting(lock, operation, deadline, **options):
            original_acquire(lock, operation, deadline, **options)
            if operation == fcntl.LOCK_SH:
                waiting.set()

        def owner():
            try:
                with ui.vm_operation(wait=0.35):
                    self.fail("timed-out owner must not gain the locked desktop")
            except ui.OperationBusy:
                pass
            except BaseException as error:
                errors.append(error)
            finally:
                finished.set()

        ui.VM_LOCK_PATH.touch(mode=0o600)
        with ui.VM_LOCK_PATH.open("rb") as desktop, patch.object(ui, "_acquire_desktop", side_effect=signal_waiting):
            fcntl.flock(desktop, fcntl.LOCK_EX)
            worker = threading.Thread(target=owner)
            worker.start()
            try:
                self.assertTrue(waiting.wait(2))
                with self.assertRaises(ui.OwnerOperationPending):
                    with ui.vm_operation():
                        self.fail("poller must yield to the owner")
                self.assertTrue(finished.wait(2))
                # Desktop still locked, but owner claim has expired.
                with self.assertRaises(ui.OperationBusy) as busy:
                    with ui.vm_operation():
                        self.fail("the original owner still holds the desktop")
                self.assertIs(type(busy.exception), ui.OperationBusy)
            finally:
                worker.join()
        self.assertEqual(errors, [])
        with ui.vm_operation():
            pass


if __name__ == '__main__':
    unittest.main()
