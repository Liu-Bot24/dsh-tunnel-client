import AppKit

let output = CommandLine.arguments[1]
let width: CGFloat = 620
let height: CGFloat = 360
let image = NSImage(size: NSSize(width: width, height: height))

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(calibratedRed: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
}

image.lockFocus()
let bounds = NSRect(x: 0, y: 0, width: width, height: height)
let gradient = NSGradient(starting: color(6, 25, 35), ending: color(13, 53, 65))
gradient?.draw(in: bounds, angle: -90)

let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .center
let titleAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 24, weight: .semibold),
    .foregroundColor: color(213, 249, 249),
    .paragraphStyle: paragraph,
]
let subtitleAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 15, weight: .regular),
    .foregroundColor: color(139, 199, 205),
    .paragraphStyle: paragraph,
]

("拖到 Applications 安装" as NSString).draw(
    in: NSRect(x: 0, y: 300, width: width, height: 34),
    withAttributes: titleAttributes
)
("Drag to Applications" as NSString).draw(
    in: NSRect(x: 0, y: 266, width: width, height: 24),
    withAttributes: subtitleAttributes
)

color(98, 218, 214).setFill()
let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 238, y: 146))
arrow.line(to: NSPoint(x: 332, y: 146))
arrow.line(to: NSPoint(x: 332, y: 122))
arrow.line(to: NSPoint(x: 392, y: 158))
arrow.line(to: NSPoint(x: 332, y: 194))
arrow.line(to: NSPoint(x: 332, y: 170))
arrow.line(to: NSPoint(x: 238, y: 170))
arrow.close()
arrow.fill()

image.unlockFocus()

guard
    let tiff = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let png = bitmap.representation(using: .png, properties: [:])
else {
    fatalError("Unable to render DMG background")
}

try png.write(to: URL(fileURLWithPath: output))
