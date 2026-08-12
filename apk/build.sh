#!/bin/bash
set -e
SRC="$1"
npm install -g cordova
rm -rf /tmp/app && mkdir -p /tmp/app
cd /tmp
cordova create app com.almani.supermarket AlmaniSupermarket
cd app
cordova plugin add onesignal-cordova-plugin
cordova platform add android@13.0.0
sed -i 's|<name>AlmaniSupermarket</name>|<name>سوبر ماركت ألماني</name>|' config.xml
ONESPREF='    <preference name="onesignal_app_id" value="9439f260-2645-4dc9-97d3-9853efa1cbf9" />'
sed -i "s|</widget>|${ONESPREF}\n</widget>|" config.xml
cp -f "$SRC/apk/google-services.json" platforms/android/app/google-services.json
cp "$SRC/apk/index.html" www/index.html
rm -rf platforms/android/app/src/main/res/mipmap-*-v26
for d in platforms/android/app/src/main/res/mipmap-*/; do
  cp "$SRC/server/public/uploads/icon-512.png" "$d/ic_launcher.png"
  cp "$SRC/server/public/uploads/icon-512.png" "$d/ic_launcher_round.png"
done
cordova build android
echo "APK_READY at: $(pwd)/platforms/android/app/build/outputs/apk/debug/app-debug.apk"
