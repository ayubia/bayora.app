const openInvitation = document.getElementById('openInvitation')
const invitationContent = document.getElementById('invitationContent')
const weddingMusic = document.getElementById('weddingMusic')
const musicControl = document.getElementById('musicControl')
const musicText = document.getElementById('musicText')

let musicPlaying = false

/* ================================
   OPEN INVITATION
================================ */

openInvitation?.addEventListener('click', async () => {

  document.body.classList.add('opened')

  invitationContent?.scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  })

  try {
    if (weddingMusic?.src) {
      await weddingMusic.play()
      musicPlaying = true
      musicText.textContent = 'Musik aktif'
    }
  } catch {
    musicPlaying = false
  }
})


/* ================================
   MUSIC
================================ */

musicControl?.addEventListener('click', async () => {

  if (!weddingMusic?.src) {
    musicText.textContent = 'Belum ada musik'
    return
  }

  if (musicPlaying) {
    weddingMusic.pause()
    musicPlaying = false
    musicText.textContent = 'Musik'
  } else {
    try {
      await weddingMusic.play()
      musicPlaying = true
      musicText.textContent = 'Musik aktif'
    } catch {
      musicText.textContent = 'Tidak dapat diputar'
    }
  }
})


/* ================================
   COUNTDOWN
================================ */

const weddingDate =
  new Date('2026-12-12T09:00:00+07:00').getTime()

function updateCountdown() {

  const now = Date.now()
  const distance = weddingDate - now

  const days = document.getElementById('days')
  const hours = document.getElementById('hours')
  const minutes = document.getElementById('minutes')
  const seconds = document.getElementById('seconds')

  if (!days || !hours || !minutes || !seconds) {
    return
  }

  if (distance <= 0) {

    days.textContent = '00'
    hours.textContent = '00'
    minutes.textContent = '00'
    seconds.textContent = '00'

    return
  }

  days.textContent =
    String(Math.floor(distance / 86400000)).padStart(2, '0')

  hours.textContent =
    String(Math.floor(distance / 3600000) % 24).padStart(2, '0')

  minutes.textContent =
    String(Math.floor(distance / 60000) % 60).padStart(2, '0')

  seconds.textContent =
    String(Math.floor(distance / 1000) % 60).padStart(2, '0')
}

updateCountdown()
setInterval(updateCountdown, 1000)


/* ================================
   RSVP
================================ */

const rsvpForm = document.getElementById('rsvpForm')
const rsvpMessage = document.getElementById('rsvpMessage')

rsvpForm?.addEventListener('submit', (event) => {

  event.preventDefault()

  if (rsvpMessage) {
    rsvpMessage.textContent =
      'Terima kasih. Konfirmasi kehadiran Anda telah diterima.'
  }

  rsvpForm.reset()
})


/* ================================
   COPY ACCOUNT
================================ */

const copyAccount = document.getElementById('copyAccount')
const accountNumber =
  document.getElementById('accountNumber')?.textContent.trim()

copyAccount?.addEventListener('click', async () => {

  if (!accountNumber) return

  try {

    await navigator.clipboard.writeText(accountNumber)

    copyAccount.textContent = 'BERHASIL DISALIN ✓'

    setTimeout(() => {
      copyAccount.textContent = 'SALIN NOMOR REKENING'
    }, 1800)

  } catch {

    alert(`Nomor rekening: ${accountNumber}`)

  }
})


/* ================================
   WISHES
================================ */

const wishForm = document.getElementById('wishForm')
const wishList = document.getElementById('wishList')

wishForm?.addEventListener('submit', (event) => {

  event.preventDefault()

  const name =
    wishForm.elements.wishName.value.trim()

  const message =
    wishForm.elements.wishMessage.value.trim()

  if (!name || !message) return

  const article = document.createElement('article')

  article.className = 'wish'

  const strong = document.createElement('strong')
  strong.textContent = name

  const paragraph = document.createElement('p')
  paragraph.textContent = message

  article.appendChild(strong)
  article.appendChild(paragraph)

  wishList?.prepend(article)

  wishForm.reset()
})


/* ================================
   SAVE DATE
================================ */

const saveDate = document.querySelector('.save-date')

saveDate?.addEventListener('click', () => {

  const start = '20261212T090000'
  const end = '20261212T140000'

  const ics =
`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Bayora//Aurelia Wedding//ID
BEGIN:VEVENT
DTSTART:${start}
DTEND:${end}
SUMMARY:Pernikahan Ayub & Nadia
LOCATION:Gedung Aster, Sukabumi, Jawa Barat
DESCRIPTION:Undangan Pernikahan Ayub & Nadia
END:VEVENT
END:VCALENDAR`

  const blob = new Blob([ics], {
    type: 'text/calendar;charset=utf-8'
  })

  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download = 'Ayub-Nadia-Wedding.ics'

  document.body.appendChild(link)
  link.click()
  link.remove()

  URL.revokeObjectURL(url)
})
