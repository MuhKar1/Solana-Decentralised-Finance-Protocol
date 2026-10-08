# Mock flash-loan callback program

A deliberately malicious flash-loan callback used by `tests/edge_cases.ts`: it
consumes the borrowed tokens without transferring them back, so the parent
`flash_loan` instruction's invariant check reverts with `FlashLoanNotRepaid`.

## Build

The test suite loads this program from `target/deploy/mock_flash_callback.so`
by program name, so it must be built and copied there before running the
flash-loan tests:

```bash
cd tests/mock-programs/mock-flash-callback
cargo build-sbf
cp target/deploy/mock_flash_callback.so ../../../target/deploy/mock_flash_callback.so
```

The program id is a random `Keypair.generate()` inside the test file, so the
`.so` does not need a fixed deployment key.
