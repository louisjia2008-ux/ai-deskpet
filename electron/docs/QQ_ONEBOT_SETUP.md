# QQ channel through a secondary account (NapCat / OneBot 11)

An alternative to the official QQ bot that needs no IP allowlist. The protocol is
unofficial: it may breach the QQ terms and the account can be restricted or banned,
so use a secondary account you can afford to lose, never your main one.

Security is unchanged. `QqOneBotAdapter` holds no policy authority, so pairing,
desktop approval, the tool ceiling and `/confirm` behave as in `QQ_CHANNEL_PLAN.md`.
It connects only to a loopback `ws://` URL with a mandatory token, admits only friend
private text segments, and sends only text segments, so CQ codes in model output stay
literal. Changing the transport or endpoint clears the binding, and switching transport
deletes the saved secret.

## Run NapCat

Requires `colima` and `docker`. NapCat has no confirmed native macOS build, so it runs
in the official arm64 image, pinned by digest in the script.

    zsh scripts/napcat/start.sh

Data and tokens live in `~/Library/Application Support/DeskPet NapCat`. `.env` holds
`WEBUI_TOKEN` and `ONEBOT_TOKEN`. Copy one without displaying it:

    sed -n 's/^ONEBOT_TOKEN=//p' "$HOME/Library/Application Support/DeskPet NapCat/.env" | tr -d '\n' | pbcopy

## Connect

1. Open `http://127.0.0.1:6099/webui`, enter `WEBUI_TOKEN`, and scan the QR code with the secondary account.
2. Make the main and secondary accounts QQ friends.
3. In DeskPet, open Settings → QQ channel and choose the secondary account method.
   Keep `ws://127.0.0.1:3001`, paste `ONEBOT_TOKEN`, choose a provider and model, then save and enable.
4. Generate a pairing code and send `/pair <code>` from the main account to the secondary account.
5. Refresh, check that the candidate is your own QQ number, and confirm it.
6. Send `/ping`, which should answer `pong`.

After a Mac restart run the script again, or Colima stays stopped. DeskPet keeps retrying
while NapCat is away. To stop: `docker stop deskpet-napcat`.
