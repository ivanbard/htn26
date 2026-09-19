# Desired User Flow for this game

## Materials:

A game starts with:
- 3 raspberry pis with cameras on each one
- 3 plates (paper plates with nfc tags on them)
- 2 stoves (paper plates with handles and nfc tags)
- 2 chopping boards (cardboard sheet with nfc tag on it, meant to be stationary during the game)
- 4 source materials (same as above but put printed icons)

## Game Setup

1. Position the raspberry pi modules as follows
- one raspberry pi at where serving should be
- other two raspberry pis covering the gameplay field from afar
2. plug in one badge into the raspberry pi at the serving area (we will call this the master pi and master badge)
3. on the master badge set to "host" mode in the app. Set "player" mode on the 3 other badges
4. Click start on the host badge and the raspberry pis take photos and generate a floor plan that it displays
5. you can approve the floorplan, and once it's approved it auto generates the burger level and tells you where to put each things

btw we're doing the burger level

cheese -> cut -> put in burger
lettuce -> cut -> put in burger
meat -> cut -> put in burger
buns -> put on plate etc.

and then possible orders are just varations on the toppings

6. games should last around 2 minutes.

## UI

So the UI should look similar to the overcooked game (there's no washing dishes)
it should show the live locations of the players (which the cameras capture)
it also shows the orders
and because this is waterloo, the customers next to serving should be a line of like standing geese (like waterloo mascot)
