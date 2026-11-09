export const SAMPLE: Record<string, string> = {
'main.py': `from utils import greet

hp = 100
print(hp)
hp = 80  # assignment: replace the value
print(hp)

squares = [n * n for n in range(1, 6)]
print("squares:", squares)
print(greet("Python"))

# name = input("Your name? ")   # type the text in the Input tab first, then Run
# print("Hello", name)
`,
'utils.py': `def greet(name):
    return f"Hello, {name}!"
`,
'games/bounce.py': `# pygame demo. Run this file (Run button). Tap/click to move the ball.
# Game loops MUST contain: await asyncio.sleep(0)  (so the browser can draw)
import asyncio
import pygame

pygame.init()
screen = pygame.display.set_mode((640, 360))
clock = pygame.time.Clock()
x, y = 320.0, 180.0
vx, vy = 4.0, 3.0


async def main():
    global x, y, vx, vy
    while True:
        for e in pygame.event.get():
            if e.type == pygame.QUIT:
                return
            if e.type == pygame.MOUSEBUTTONDOWN:
                x, y = e.pos
        x += vx
        y += vy
        if x < 20 or x > 620:
            vx = -vx
        if y < 20 or y > 340:
            vy = -vy
        screen.fill((30, 30, 40))
        pygame.draw.circle(screen, (240, 90, 90), (int(x), int(y)), 20)
        pygame.display.flip()
        clock.tick(60)
        await asyncio.sleep(0)


asyncio.run(main())
`,
'requirements.txt': '# One pure-Python PyPI package per line (installed with micropip before running)\n',
};
