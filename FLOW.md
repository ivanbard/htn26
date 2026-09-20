# Desired User Flow for this game

## Materials:

A game starts with the server on the captain's laptop, Apple-phone setup
photos, one stationary host badge, and three fixed player badges. QNX is only a
possible future server target. The physical level has four NFC zones: pantry,
fridge, cutting board, and stove.

## Game Setup

1. Photograph the play area with the phone and upload the stills to the laptop server.
2. Connect the stationary host badge to the captain's laptop and open its host app; open the player app on the three badges.
3. Choose the personalized floor layout when the phone photos arrive, or choose the normal layout as the fallback, then place the four NFC zones as instructed.
4. Press START on the host badge. It starts its local four-minute display,
   resets the badge session, and emits `HTN26|GAME|START_GAME|240|3` to serial
   and as a best-effort radio lifecycle hint. The laptop server applies that
   record as the authoritative round start and runs the game countdown.
5. When the host countdown ends, the host emits
   `HTN26|GAME|GAME_END|3` and resets its session; the laptop server applies the
   authoritative end transition and cleanup.

btw we're doing the burger level

cheese -> cut -> put in burger
lettuce -> cut -> put in burger
meat -> cut -> put in burger
buns -> put on plate etc.

and then possible orders are just varations on the toppings

6. The laptop server receives player events only through the host badge's one-way radio-to-serial gateway path.

## UI

The current simulator UI is deliberately plain text. It shows each fixed player
only under the server-inferred station or center/default, with held items and
explicit action state; the setup camera does not track live player locations.
It also shows the orders. A possible future designed UI can use Waterloo geese
as the customers next to serving without changing these state boundaries.
