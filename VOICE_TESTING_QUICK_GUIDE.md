# Voice Testing Quick Reference Guide

**⏱️ Time Required:** 30 minutes
**📋 Status:** Ready to Execute

---

## 🎯 What You Need to Do

This is **MANUAL TESTING** - you interact with ChatGPT voice input while observing what happens in the browser console and network traffic.

---

## 🚀 Quick Start (TL;DR)

1. **Open ChatGPT** with DevTools open (F12)
2. **Verify extension loaded** (look for 🚀 emoji in console)
3. **Enable "Preserve log"** in Network tab
4. **Do 3 tests:**
   - Test A: Type text message (baseline)
   - Test B: Voice input message
   - Test C: Voice input, edit, then submit
5. **Compare:**
   - Are console logs the same for voice vs text?
   - Are network endpoints the same?
   - Are request payloads the same?
6. **Share findings** with me (screenshots + answers)

---

## 📸 Screenshots I Need

### Must Have:
1. **Console logs during voice input** (showing 🎯 and ✅ emojis)
2. **Network tab** showing the request URL
3. **Request payload** for voice input (JSON body)

### Nice to Have:
4. Request payload for text input (comparison)
5. Supabase query showing captured message

---

## 🔍 Key Questions to Answer

After testing, tell me:

1. **Did console show these logs during voice input?**
   ```
   🎯 KYT ChatGPT: Intercepted API call
   ✅ KYT ChatGPT: Message extracted
   ```
   - [ ] YES (existing code works!)
   - [ ] NO (need to implement)

2. **What endpoint did voice input use?**
   - `/backend-api/conversation` (same as text)
   - `/backend-api/audio` (different)
   - Other: __________

3. **Was the request payload identical to text input?**
   - [ ] YES (no code changes needed)
   - [ ] NO (need to parse new format)

4. **Did voice-then-edit work correctly?**
   - [ ] YES (captured edited text)
   - [ ] NO (only captured transcription)

---

## ⚡ Fastest Path to Results

If you're short on time:

**Minimum viable test** (10 minutes):
1. Load ChatGPT with extension
2. Open console (F12)
3. Voice input: "Hello world"
4. Check if you see: `🎯 Intercepted API call`
5. Tell me YES or NO

**That's it!** Everything else is bonus detail.

---

## 🎬 What Happens Next

Based on your **YES/NO** answer:

**If YES** (console shows interception):
- ✅ Existing code already works
- No implementation needed
- Just documentation + testing
- **Total time:** 1-2 hours

**If NO** (no console logs):
- Need to add voice detection
- Minor code changes required
- **Total time:** 4-6 hours

---

## 📞 Ready When You Are

**Option 1:** Complete full testing (~30 min) → Give me all details → I implement

**Option 2:** Quick test (~10 min) → Tell me YES/NO → We decide next steps

**Option 3:** Share screen → We do it together → Real-time analysis

Which option works best for you?

---

**Full instructions:** See `PHASE1_VOICE_TESTING_INSTRUCTIONS.md`
**Research template:** See `VOICE_RESEARCH_RESULTS_TEMPLATE.md`
**Implementation plan:** See `VOICE_INPUT_CAPTURE_PLAN.md`
