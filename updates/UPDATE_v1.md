# Update 1

The current launch uses the captain's laptop as the server. There is no
dedicated camera, and there are only four NFC stickers, so here is the revised
plan:

## Materials

Game starts with
- One captain's laptop plus Apple-phone still photographs for setup. Any setup
  provider runs behind the laptop server; a Raspberry Pi/QNX target remains a
  possible future adapter.
- One NFC tag representing the "pantry" (bread and lettuce)
- One NFC tag representing the "fridge" (cheese and meat)
- One for cutting board area
- One for stove area

## Game Setup

1. Go around the room and take photos of the game play area, uploading them to the laptop server.
2. The laptop should be connected to the host badge and the server should be running.
3. Open the local web view served from the laptop.
4. On the screen, the server's setup provider proposes a floor plan from the uploaded images and asks whether it is acceptable.
5. If so, we generate the gameplay level and instruct where to put each of the NFC tags
6. Place the NFC tags on each zone, select host on the host badge and player on each of the other badges
7. Prepare the game in the web UI, then start the physical round on the host badge; orders appear when its serial start record reaches the server.

## Gameplay loop

1. The badges don't know when the game starts, but that's ok, because the game always works on this deterministic way

### Pantry and Fridge: Hand is empty

You click "right" and scan text "pantry" from the NFC: pick up bread and display it on the badge, you are now holding bread. Broadcast on radio player X picked up bread
You click "left" and scan text "pantry" from the NFC: same as above but with lettuce
you click "right" and scan text "fridge", you pick up cheese
you click "left" and scan text "fridge" you pick up meat

### Pantry and Fridge: Hand is holding platable item (cooked meat, bun, sliced lettuce, sliced cheese)

You click on down and scan the "pantry" from the NFC, plate the item currently held and hold a plate with the new ingredients

### Dropping item

You hold "B" and shake: delete the item and broadcast that item dropped

### Cutting board

You click and hold A, and scan the "cutting board" NFC tag, and share, you slowly cut the item. Light up all 6 lights one by one to show progress. If you let go of A at any time before you finish chopping, lose all progress

### Stoves

There's two stoves left and right, you select by holding the button and tapping on the stove
1. clicking on a stove no matter what shows the progress that stove has via the lights (yellow lights x/6 progress)
2. if a food is going to overcook, the lights show red flashing
3. if hand is empty and food is done cooking, then tapping it will pick up the finished cooked meat
4. if hand is holding raw cut meat and stove is empty, then put the raw meat on the stove
5. if the meat is burnt, then Red lights are solid and users must use mepty hand to pick up the burnt meat and then drop it

### Submission

Player X must be holding a plate (may be empty or non empty). Hold A and shake. If all other players are shaking at the same time (they don't need to hold A) then it submits the current item. 
Badges broadcast what got submitted and "drops" what they were holding

## Communication with UI

Almost all actions should have broadcast over the radio
The broadcasts get picked up by the host badge, which logs them over serial for the laptop server to consume.
This updates the UI so show live:
- each player
- which each player it holding
- the server applies submission penalties, tips, and bonus gold depending on
  whether it matches a real order, and the UI displays that authoritative result
