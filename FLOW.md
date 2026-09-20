# Desired User Flow for this game

## Materials:

A game starts with the server on the captain's laptop, Apple-phone setup
photos, one stationary host badge, and three fixed player badges. QNX is only a
possible future server target. The physical level has four NFC zones: pantry,
fridge, cutting board, and stove.

## Game Setup

1. Photograph the play area with the phone and upload the stills to the laptop server.
2. Connect the stationary host badge to the captain's laptop and open its host app; open the player app on the three badges.
3. Generate and approve the floor plan on the local UI, then place the four NFC zones as instructed.
4. Press START on the host badge. It owns the four-minute countdown, resets the fixed-player session, and emits `HTN26|GAME|START_GAME|240|3` to serial and as a best-effort radio lifecycle hint.
5. When the countdown ends, the host emits `HTN26|GAME|GAME_END|3` and resets the host session.

btw we're doing the burger level

cheese -> cut -> put in burger
lettuce -> cut -> put in burger
meat -> cut -> put in burger
buns -> put on plate etc.

and then possible orders are just varations on the toppings

6. The laptop server receives player events only through the host badge's one-way radio-to-serial gateway path.

## UI

So the UI should look similar to the overcooked game (there's no washing dishes)
it should show the fixed player icons, held items, and action state; the setup camera does not track live player locations
it also shows the orders
and because this is waterloo, the customers next to serving should be a line of like standing geese (like waterloo mascot)
