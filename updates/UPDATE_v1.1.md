# Responses to V1

1. If there are unvalid button + NFC combinations, we should flash red for a second and say "unknown button combo"
2. Yes that's correct, there is no delivery zone, instead the players must communicate to all shake at once
3. This is something that is a real hole, I specified more below
4. Written below

## Plate handling

You can pick up a plate with an empty hand or if you're holding platable items
Thsi will give you a plate and put any platable items you have on it
From then on, picking up anything platable will simply add it to your plate, you cannot pick up non platable items
You cannot duplicate items on the plate. The bun is one object and includes the top and bottom buns together
Tapping two badges together, if one has a plate and one does not, will try to move the object from the no plate badge to the plate badge (if its platable, otherwise, it switching the items)
Tapping two badges together, if they both have a plate, swap the items
Tapping two badges together, if neither have a plate, swap the items

## Cooking state

cooking for 15 secs, then its done for 2 secs, flashing warning for 3 secs, then burnt after that
raw meat must be cut before it hits the stove

## Stove selection

Maybe it should show the stove number and what's on it on the screen

## Submission

Plate is consumed
Shaking state persists for half a second during big changes in g force
If all players are shaking at the same time we submit

# Other responses

I don't care how players join so long as they get unique player numbers
Ignore events sent before game starts. Actually, revision to v1, we should click game start on the host badge, and it broadcasts that to all badges, telling them to wipe their memory etc, and also the ui hears it on the serial and starts the game
After two minutes the host badge should broadcast game end which also wipes everything
There's no retry, a failed order causes a penalty and the plate still gets consumed
hopefully that shouldn't happen but it should keep trying to reconnect
that shouldn't happen but assume it doesn't we can fix later
the host badge should actually show a counting down timer
yes players can hold items indefinetly but it gets wiped at game end

Yes, we no longer will know where players are, so just keep the player icons at the bottom, and what they're holding, but when chopping the UI should know they're chopping, and we can broadcast done chopping or failed chopping after, things like that
The screen/ui should also know how cooked the meat is because it knows when it started ykno.
the photos are just to set up the level
