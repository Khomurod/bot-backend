# Credits: the celebration car

`wenze-car.glb` is derived from **"Car Concept"** from the Khronos glTF Sample
Assets
(<https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept>):

> © 2024, Darmstadt Graphics Group GmbH — model and textures by Eric Chadwick.
> Licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/legalcode).
> Started from a public-domain (CC0) concept car by Unity Fan.

**Changes made here (12 October 2026):**

- the Khronos Group and 3DCommerce marks are removed: the banner texture now
  reads WENZE (the licence plate), the emissive uses of that banner are switched
  off, and the tyre sidewall logos are erased from its colour and normal maps;
- the "Carmine Candy" paint is baked in and the other two variants dropped;
- geometry is meshopt-compressed and textures are WebP at most 1024 px.

The attribution is shown on screen while the car is (`CelebrationOverlay.jsx`).
The marks were removed because the Khronos trademark is not covered by the CC BY
licence. Do not put them back.
